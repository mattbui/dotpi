import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

const DEFAULT_SEARCH_RESULTS = 5;
const DEFAULT_MAX_TEXT_RESULTS = 3;
const DEFAULT_MAX_CHARS_PER_RESULT = 4000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const WebSearchParams = Type.Object({
  query: Type.String({ description: "Search query. Prefer narrow, source-seeking queries." }),
  numResults: Type.Optional(Type.Number({ description: "Number of Exa results to return. Default: 5." })),
  includeText: Type.Optional(Type.Boolean({ description: "Include capped page text excerpts. Default: true." })),
  maxTextResults: Type.Optional(Type.Number({ description: "Maximum number of top results to show text for. Default: 3." })),
  maxCharactersPerResult: Type.Optional(Type.Number({ description: "Maximum text excerpt characters per result. Default: 4000." })),
  includeDomains: Type.Optional(Type.Array(Type.String(), { description: "Domains to include, e.g. ['docs.exa.ai']." })),
  excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Domains to exclude." })),
  startPublishedDate: Type.Optional(Type.String({ description: "Earliest publish date, ISO 8601 or YYYY-MM-DD." })),
  endPublishedDate: Type.Optional(Type.String({ description: "Latest publish date, ISO 8601 or YYYY-MM-DD." })),
});

const WebScrapeParams = Type.Object({
  url: Type.String({ description: "HTTP or HTTPS URL to scrape." }),
  formats: Type.Optional(Type.Array(Type.String(), { description: "Firecrawl output formats. Default: ['markdown']." })),
  onlyMainContent: Type.Optional(Type.Boolean({ description: "Return main page content only. Default: true." })),
  timeout: Type.Optional(Type.Number({ description: "Provider timeout in milliseconds. Default: 30000." })),
  waitFor: Type.Optional(Type.Number({ description: "Milliseconds to wait before scraping dynamic pages." })),
  includeLinks: Type.Optional(Type.Boolean({ description: "Include links when Firecrawl returns them. Default: false." })),
});

type JsonRecord = Record<string, unknown>;

type ExaResult = {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  text?: string;
  highlights?: string[];
};

type WebToolDetails = {
  provider: "exa" | "firecrawl";
  url?: string;
  query?: string;
  resultCount?: number;
  truncated?: boolean;
  isError?: boolean;
  error?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function getPositiveInteger(value: unknown, fallback: number, min = 1, max = 50): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, number));
}

function getBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function assertHttpUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`URL must use http or https: ${url}`);
  }

  return parsed.toString();
}

function compactWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

function truncateText(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  return `${text.slice(0, Math.max(0, maxCharacters - 1)).trimEnd()}…`;
}

function truncateLabel(text: string, maxCharacters = 96): string {
  const clean = compactWhitespace(text).replace(/\n/g, " ");
  return truncateText(clean, maxCharacters);
}

function getResultText(result: { content: { type: string; text?: string }[] }): string {
  const text = result.content.find((content) => content.type === "text");
  return text?.text ?? "";
}

function previewResultText(text: string, maxLines = 5, maxCharactersPerLine = 140): { text: string; remainingLines: number } {
  const lines = text
    .split("\n")
    .map((line) => compactWhitespace(line))
    .filter(Boolean);
  const preview = lines.slice(0, maxLines).map((line) => truncateText(line, maxCharactersPerLine));

  return {
    text: preview.join("\n"),
    remainingLines: Math.max(0, lines.length - preview.length),
  };
}

function countPreviewLines(text: string): number {
  return text
    .split("\n")
    .map((line) => compactWhitespace(line))
    .filter(Boolean).length;
}

function truncateToolOutput(text: string): { text: string; truncated: boolean } {
  const truncation = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });

  if (!truncation.truncated) return { text: truncation.content, truncated: false };

  const omittedLines = truncation.totalLines - truncation.outputLines;
  const omittedBytes = truncation.totalBytes - truncation.outputBytes;
  return {
    text:
      `${truncation.content}\n\n` +
      `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines ` +
      `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
      `${omittedLines} lines (${formatSize(omittedBytes)}) omitted.]`,
    truncated: true,
  };
}

function toolError(provider: WebToolDetails["provider"], message: string, details: Omit<WebToolDetails, "provider" | "isError" | "error"> = {}) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    details: {
      ...details,
      provider,
      isError: true,
      error: message,
    } satisfies WebToolDetails,
  };
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  upstreamSignal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  const abort = () => controller.abort(upstreamSignal?.reason);

  try {
    if (upstreamSignal) {
      if (upstreamSignal.aborted) abort();
      else upstreamSignal.addEventListener("abort", abort, { once: true });
    }

    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const text = await response.text();
    const body = text ? parseJsonResponse(text) : undefined;

    if (!response.ok) {
      const message = (extractProviderError(body) ?? text.slice(0, 1000)) || response.statusText;
      throw new Error(`HTTP ${response.status}: ${message}`);
    }

    return body;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(String(error));
  } finally {
    clearTimeout(timeout);
    if (upstreamSignal) upstreamSignal.removeEventListener("abort", abort);
  }
}

function parseJsonResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Provider returned non-JSON response: ${text.slice(0, 1000)}`);
  }
}

function extractProviderError(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;

  const error = body.error;
  if (typeof error === "string") return error;
  if (isRecord(error)) {
    return asString(error.message) ?? asString(error.error) ?? JSON.stringify(error).slice(0, 1000);
  }

  return asString(body.message) ?? asString(body.detail);
}

function formatSearchResults(results: ExaResult[], includeText: boolean, maxTextResults: number, maxCharactersPerResult: number): string {
  if (results.length === 0) return "No search results found.";

  const sections = results.map((result, index) => {
    const title = result.title || "(untitled)";
    const url = result.url || "(no url)";
    const lines = [`## ${index + 1}. ${title}`, `URL: ${url}`];

    if (result.publishedDate) lines.push(`Published: ${result.publishedDate}`);
    if (result.author) lines.push(`Author: ${result.author}`);

    if (result.highlights && result.highlights.length > 0) {
      lines.push("", "Highlights:");
      for (const highlight of result.highlights) {
        lines.push(`- ${compactWhitespace(highlight)}`);
      }
    }

    if (includeText && index < maxTextResults && result.text) {
      lines.push("", "Text excerpt:", truncateText(compactWhitespace(result.text), maxCharactersPerResult));
    }

    return lines.join("\n");
  });

  return sections.join("\n\n");
}

function normalizeExaResults(body: unknown): ExaResult[] {
  if (!isRecord(body) || !Array.isArray(body.results)) return [];

  return body.results
    .filter(isRecord)
    .map((result) => ({
      title: asString(result.title),
      url: asString(result.url),
      publishedDate: asString(result.publishedDate),
      author: asString(result.author),
      text: asString(result.text),
      highlights: asStringArray(result.highlights),
    }));
}

function getFirecrawlData(body: unknown): JsonRecord {
  if (!isRecord(body)) return {};
  if (isRecord(body.data)) return body.data;
  return body;
}

function formatScrapeResult(url: string, body: unknown, includeLinks: boolean): string {
  const data = getFirecrawlData(body);
  const metadata = isRecord(data.metadata) ? data.metadata : {};
  const title = asString(metadata.title) ?? asString(data.title);
  const pageUrl = asString(metadata.sourceURL) ?? asString(metadata.url) ?? url;
  const markdown = asString(data.markdown);
  const html = asString(data.html);
  const text = markdown ?? html ?? asString(data.content) ?? "";

  if (!text.trim()) {
    return `No page content returned for ${pageUrl}.`;
  }

  const lines: string[] = [];
  if (title) lines.push(`# ${title}`, "");
  lines.push(`URL: ${pageUrl}`, "", compactWhitespace(text));

  const links = includeLinks ? asStringArray(data.links) : [];
  if (links.length > 0) {
    lines.push("", "Links:");
    for (const link of links.slice(0, 100)) lines.push(`- ${link}`);
    if (links.length > 100) lines.push(`- ... ${links.length - 100} more links omitted`);
  }

  return lines.join("\n");
}

const webSearchTool = defineTool({
  name: "web_search",
  label: "Web Search",
  description:
    "Search the live web with Exa. Cost-focused default returns 5 results, highlights for all results, and capped text excerpts for the top 3. Use before web_scrape when discovering sources.",
  promptSnippet: "Search the live web with Exa; use before scraping when you need candidate URLs.",
  promptGuidelines: [
    "Use web_search first for discovery and most docs/current-info lookups.",
    "Prefer narrow queries and default result counts to reduce API calls.",
    "Answer from web_search results when highlights and text excerpts are enough.",
  ],
  parameters: WebSearchParams,
  executionMode: "parallel",

  async execute(_toolCallId, params, signal) {
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey) {
      return toolError("exa", "Missing EXA_API_KEY environment variable.", { query: params.query });
    }

    const numResults = getPositiveInteger(params.numResults, DEFAULT_SEARCH_RESULTS, 1, 10);
    const includeText = getBoolean(params.includeText, true);
    const maxTextResults = getPositiveInteger(params.maxTextResults, DEFAULT_MAX_TEXT_RESULTS, 0, numResults);
    const maxCharactersPerResult = getPositiveInteger(
      params.maxCharactersPerResult,
      DEFAULT_MAX_CHARS_PER_RESULT,
      500,
      20_000,
    );
    const shouldRequestText = includeText && maxTextResults > 0;

    const body: JsonRecord = {
      query: params.query,
      type: "auto",
      numResults,
      contents: {
        highlights: true,
      },
    };
    if (shouldRequestText) {
      body.contents = {
        highlights: true,
        text: { maxCharacters: maxCharactersPerResult },
      };
    }

    if (params.includeDomains?.length) body.includeDomains = params.includeDomains;
    if (params.excludeDomains?.length) body.excludeDomains = params.excludeDomains;
    if (params.startPublishedDate) body.startPublishedDate = params.startPublishedDate;
    if (params.endPublishedDate) body.endPublishedDate = params.endPublishedDate;

    try {
      const json = await fetchJson(
        EXA_SEARCH_URL,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify(body),
        },
        DEFAULT_REQUEST_TIMEOUT_MS,
        signal,
      );

      const results = normalizeExaResults(json);
      const output = formatSearchResults(results, shouldRequestText, maxTextResults, maxCharactersPerResult);
      const truncated = truncateToolOutput(output);

      return {
        content: [{ type: "text", text: truncated.text }],
        details: {
          provider: "exa",
          query: params.query,
          resultCount: results.length,
          truncated: truncated.truncated,
        } satisfies WebToolDetails,
      };
    } catch (error) {
      return toolError("exa", error instanceof Error ? error.message : String(error), { query: params.query });
    }
  },

  renderCall(args, theme) {
    return new Text(
      theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", `"${truncateLabel(args.query)}"`),
      0,
      0,
    );
  },

  renderResult(result, { expanded, isPartial }, theme, context) {
    if (isPartial) return new Text(theme.fg("warning", "Searching web..."), 0, 0);

    const details = result.details as WebToolDetails | undefined;
    if (details?.isError) {
      return new Text(theme.fg("error", details.error ?? "Web search failed"), 0, 0);
    }

    const count = details?.resultCount ?? 0;
    let text = theme.fg("success", `${count} result${count === 1 ? "" : "s"}`);
    if (details?.truncated) text += theme.fg("warning", " (truncated)");

    if (expanded) {
      const output = getResultText(result);
      if (output) text += `\n${theme.fg("toolOutput", output)}`;
    } else {
      const preview = previewResultText(getResultText(result), 5);
      if (preview.text) text += `\n${theme.fg("toolOutput", preview.text)}`;
      text += `\n${theme.fg("dim", `...(${preview.remainingLines} more lines, ctrl+o to expand)`)}`;
    }

    return new Text(text, 0, 0);
  },
});

const webScrapeTool = defineTool({
  name: "web_scrape",
  label: "Web Scrape",
  description:
    "Scrape one exact URL with Firecrawl and return clean markdown. Use only when web_search output is insufficient or exact page content is needed.",
  promptSnippet: "Fetch clean markdown content for a specific URL using Firecrawl.",
  promptGuidelines: [
    "Use web_scrape only for the single best URL when exact content, code blocks, tables, or fuller docs content are needed.",
    "Cite source URLs from web_search and web_scrape results in final answers.",
  ],
  parameters: WebScrapeParams,
  executionMode: "parallel",

  async execute(_toolCallId, params, signal) {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) {
      return toolError("firecrawl", "Missing FIRECRAWL_API_KEY environment variable.", { url: params.url });
    }

    let url: string;
    try {
      url = assertHttpUrl(params.url);
    } catch (error) {
      return toolError("firecrawl", error instanceof Error ? error.message : String(error), { url: params.url });
    }

    const timeout = getPositiveInteger(params.timeout, DEFAULT_REQUEST_TIMEOUT_MS, 1000, 120_000);
    const formats = params.formats?.length ? params.formats : ["markdown"];
    const includeLinks = getBoolean(params.includeLinks, false);

    const body: JsonRecord = {
      url,
      formats,
      onlyMainContent: getBoolean(params.onlyMainContent, true),
      timeout,
      blockAds: true,
      removeBase64Images: true,
    };

    if (typeof params.waitFor === "number" && Number.isFinite(params.waitFor)) {
      body.waitFor = Math.max(0, Math.floor(params.waitFor));
    }

    if (includeLinks && !formats.includes("links")) {
      body.formats = [...formats, "links"];
    }

    try {
      const json = await fetchJson(
        FIRECRAWL_SCRAPE_URL,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
        timeout + 5000,
        signal,
      );
      if (isRecord(json) && json.success === false) {
        return toolError("firecrawl", extractProviderError(json) ?? "Firecrawl scrape failed.", { url });
      }

      const output = formatScrapeResult(url, json, includeLinks);
      const truncated = truncateToolOutput(output);

      return {
        content: [{ type: "text", text: truncated.text }],
        details: {
          provider: "firecrawl",
          url,
          truncated: truncated.truncated,
        } satisfies WebToolDetails,
      };
    } catch (error) {
      return toolError("firecrawl", error instanceof Error ? error.message : String(error), { url });
    }
  },

  renderCall(args, theme) {
    return new Text(
      theme.fg("toolTitle", theme.bold("web_scrape ")) + theme.fg("accent", truncateLabel(args.url)),
      0,
      0,
    );
  },

  renderResult(result, { expanded, isPartial }, theme, context) {
    if (isPartial) return new Text(theme.fg("warning", "Scraping page..."), 0, 0);

    const details = result.details as WebToolDetails | undefined;
    if (details?.isError) {
      return new Text(theme.fg("error", details.error ?? "Web scrape failed"), 0, 0);
    }

    const output = getResultText(result);
    const lineCount = countPreviewLines(output);
    let text = theme.fg("success", `${lineCount} line${lineCount === 1 ? "" : "s"}`);
    if (details?.truncated) text += theme.fg("warning", " (truncated)");

    if (expanded) {
      if (output) text += `\n${theme.fg("toolOutput", output)}`;
    } else {
      const preview = previewResultText(output, 6);
      if (preview.text) text += `\n${theme.fg("toolOutput", preview.text)}`;
      text += `\n${theme.fg("dim", `...(${preview.remainingLines} more lines, ctrl+o to expand)`)}`;
    }

    return new Text(text, 0, 0);
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(webSearchTool);
  pi.registerTool(webScrapeTool);
}
