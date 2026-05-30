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

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

const DEFAULT_SEARCH_RESULTS = 5;
const DEFAULT_MAX_CHARS_PER_RESULT = 4000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TAVILY_SEARCH_DEPTH = "basic";

const WebSearchParams = Type.Object({
  query: Type.String({ description: "Narrow web search query." }),
  maxResults: Type.Optional(Type.Number({ description: "Maximum results to return. Default: 5." })),
  topic: Type.Optional(Type.String({ description: "Result category: general, news, or finance." })),
  timeRange: Type.Optional(Type.String({ description: "Recency filter: day, week, month, year, d, w, m, or y." })),
  includeDomains: Type.Optional(Type.Array(Type.String(), { description: "Only include these domains." })),
  excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Domains to exclude." })),
  startDate: Type.Optional(Type.String({ description: "Earliest result date as YYYY-MM-DD." })),
  endDate: Type.Optional(Type.String({ description: "Latest result date as YYYY-MM-DD." })),
});

const WebScrapeParams = Type.Object({
  url: Type.String({ description: "HTTP or HTTPS URL to scrape." }),
  formats: Type.Optional(Type.Array(Type.String(), { description: "Output formats. Default: ['markdown']." })),
  onlyMainContent: Type.Optional(Type.Boolean({ description: "Return main content only. Default: true." })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Default: 30000." })),
  waitFor: Type.Optional(Type.Number({ description: "Milliseconds to wait before scraping." })),
  includeLinks: Type.Optional(Type.Boolean({ description: "Include extracted links. Default: false." })),
});

type JsonRecord = Record<string, unknown>;

type SearchResult = {
  title?: string;
  url?: string;
  publishedDate?: string;
  text?: string;
};

type WebToolDetails = {
  provider: "tavily" | "firecrawl";
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

function truncateSearchContent(text: string): { text: string; truncated: boolean } {
  const clean = compactWhitespace(text);
  return {
    text: truncateText(clean, DEFAULT_MAX_CHARS_PER_RESULT),
    truncated: clean.length > DEFAULT_MAX_CHARS_PER_RESULT,
  };
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

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No search results found.";

  const sections = results.map((result, index) => {
    const title = result.title || "(untitled)";
    const url = result.url || "(no url)";
    const lines = [`## ${index + 1}. ${title}`, `URL: ${url}`];

    if (result.publishedDate) lines.push(`Published: ${result.publishedDate}`);

    if (result.text) {
      const content = truncateSearchContent(result.text);
      lines.push("", "Content:", content.text);
      if (content.truncated) lines.push("[content truncated]");
    }

    return lines.join("\n");
  });

  return sections.join("\n\n");
}

function normalizeTavilyResults(body: unknown): SearchResult[] {
  if (!isRecord(body) || !Array.isArray(body.results)) return [];

  return body.results
    .filter(isRecord)
    .map((result) => ({
      title: asString(result.title),
      url: asString(result.url),
      publishedDate: asString(result.published_date),
      text: asString(result.raw_content) ?? asString(result.content),
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
  description: "Search the live web. Use before web_scrape when discovering sources.",
  promptSnippet: "Search the live web for candidate sources.",
  promptGuidelines: [
    "Use web_search first for discovery and current docs/info lookups.",
    "Prefer narrow queries and default result counts to reduce API calls.",
  ],
  parameters: WebSearchParams,
  executionMode: "parallel",

  async execute(_toolCallId, params, signal) {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      return toolError("tavily", "Missing TAVILY_API_KEY environment variable.", { query: params.query });
    }

    const maxResults = getPositiveInteger(params.maxResults, DEFAULT_SEARCH_RESULTS, 1, 20);

    const body: JsonRecord = {
      query: params.query,
      search_depth: DEFAULT_TAVILY_SEARCH_DEPTH,
      max_results: maxResults,
      topic: asString(params.topic) ?? "general",
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_favicon: false,
      include_usage: true,
    };

    if (params.includeDomains?.length) body.include_domains = params.includeDomains;
    if (params.excludeDomains?.length) body.exclude_domains = params.excludeDomains;
    if (params.timeRange) body.time_range = params.timeRange;
    if (params.startDate) body.start_date = params.startDate;
    if (params.endDate) body.end_date = params.endDate;

    try {
      const json = await fetchJson(
        TAVILY_SEARCH_URL,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
        DEFAULT_REQUEST_TIMEOUT_MS,
        signal,
      );

      const results = normalizeTavilyResults(json);
      const output = formatSearchResults(results);
      const truncated = truncateToolOutput(output);

      return {
        content: [{ type: "text", text: truncated.text }],
        details: {
          provider: "tavily",
          query: params.query,
          resultCount: results.length,
          truncated: truncated.truncated,
        } satisfies WebToolDetails,
      };
    } catch (error) {
      return toolError("tavily", error instanceof Error ? error.message : String(error), { query: params.query });
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
  description: "Scrape one exact URL and return clean page content.",
  promptSnippet: "Fetch clean page content for a specific URL.",
  promptGuidelines: [
    "Use web_scrape when exact page content, code blocks, tables, or fuller docs content are needed.",
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
