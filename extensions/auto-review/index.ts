/**
 * Pi extension entrypoint.
 *
 * This file wires together the protected-mode flow:
 * - overrides Pi's built-in `bash` tool with policy review plus sandboxed execution
 * - intercepts file operation tools through `tool_call`
 * - routes ambiguous actions to the reviewer
 * - asks the user for sensitive paths or reviewer-requested escalations
 * - exposes `/auto-review ...` commands and footer status text
 */
import {
  createBashToolDefinition,
  isToolCallEventType,
  type AgentToolUpdateCallback,
  type BashToolDetails,
  type BashToolInput,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  buildSandboxFallbackAction,
  classifyBashCommand,
  classifyFileOperationTool,
  formatActionForUser,
  reviewAllowed,
  reviewEscalatesToUser,
  type PolicyDecision,
  type ReviewAction,
} from "./policy.ts";
import { runAutoReview, type ReviewerConfig } from "./reviewer.ts";
import {
  createSandboxedBashOps,
  DEFAULT_SANDBOX_CONFIG,
  initializeSandbox,
  isSandboxDeniedError,
  resetSandbox,
  sandboxDenialText,
  type AutoReviewSandboxConfig,
} from "./bash-sandbox.ts";

type SandboxFallbackMode = "off" | "auto-review" | "user";

type AutoReviewConfig = {
  enabled: boolean;
  sandboxFallback: SandboxFallbackMode;
  userApprovalTimeoutMs: number;
  reviewer: ReviewerConfig;
  sandbox: AutoReviewSandboxConfig;
};

const STATUS_KEY = "auto-review";
const DEFAULT_CONFIG: AutoReviewConfig = {
  enabled: true,
  sandboxFallback: "auto-review",
  userApprovalTimeoutMs: 60_000,
  reviewer: {
    modelProvider: "openai-codex",
    modelId: "codex-auto-review",
    reasoningEffort: "low",
    // Codex Guardian does not set an explicit max output token cap.
    // maxTokens: 512,
  },
  sandbox: DEFAULT_SANDBOX_CONFIG,
};

export default function (pi: ExtensionAPI) {
  let config = DEFAULT_CONFIG;
  let sandboxReady = false;
  let sandboxStatusNote: string | undefined;

  const baseBash = createBashToolDefinition(process.cwd());

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (!config.enabled) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, sandboxReady ? "auto-review:sandbox" : "auto-review");
  }

  function setSandboxOff(note?: string): void {
    config = { ...config, sandbox: { ...config.sandbox, enabled: false } };
    sandboxReady = false;
    sandboxStatusNote = note;
  }

  async function tryEnableSandbox(): Promise<boolean> {
    try {
      const initialized = await initializeSandbox(config.sandbox);
      if (!initialized) {
        setSandboxOff("unavailable");
        return false;
      }
      sandboxReady = true;
      sandboxStatusNote = undefined;
      return true;
    } catch (error) {
      setSandboxOff(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function askUser(ctx: ExtensionContext, title: string, body: string): Promise<boolean> {
    if (!ctx.hasUI) return false;

    pi.events.emit("notify:attention", {
      kind: "confirm",
      title,
      timeoutMs: config.userApprovalTimeoutMs,
      sessionName: pi.getSessionName() || ctx.sessionManager.getSessionName(),
    });

    return ctx.ui.confirm(title, body, { timeout: config.userApprovalTimeoutMs });
  }

  async function withWorkingMessage<T>(ctx: ExtensionContext, message: string, fn: () => Promise<T>): Promise<T> {
    if (!ctx.hasUI) return fn();
    ctx.ui.setWorkingMessage(message);
    try {
      return await fn();
    } finally {
      ctx.ui.setWorkingMessage();
    }
  }

  async function resolveDecision(decision: PolicyDecision, ctx: ExtensionContext): Promise<{ allow: true } | { allow: false; reason: string }> {
    if (decision.kind === "allow") return { allow: true };
    if (decision.kind === "deny") return { allow: false, reason: decision.reason };

    if (decision.kind === "user_approval") {
      const ok = await askUser(ctx, "Approve protected tool call?", formatActionForUser(decision.action, decision.reason));
      return ok ? { allow: true } : { allow: false, reason: "Blocked by user" };
    }

    const review = await withWorkingMessage(ctx, autoReviewMessage(decision.action), () => runAutoReview(decision.action, ctx, config.reviewer, ctx.signal));
    if (reviewAllowed(review)) return { allow: true };
    if (reviewEscalatesToUser(review)) {
      const ok = await askUser(ctx, "Approve protected tool call?", formatActionForUser(decision.action, `Auto reviewer requested user approval: ${review.rationale}`));
      return ok ? { allow: true } : { allow: false, reason: "Blocked by user" };
    }
    return { allow: false, reason: `Blocked by auto review: ${review.rationale}` };
  }

  async function reviewSandboxFallback(
    action: ReviewAction,
    ctx: ExtensionContext,
  ): Promise<{ allow: true } | { allow: false; reason: string }> {
    if (config.sandboxFallback === "off") {
      return { allow: false, reason: "Retry without sandbox is disabled" };
    }

    if (config.sandboxFallback === "user") {
      const ok = await askUser(ctx, "Retry without sandbox?", formatActionForUser(action, "Sandbox denied this command"));
      return ok ? { allow: true } : { allow: false, reason: "Retry without sandbox blocked by user" };
    }

    const review = await withWorkingMessage(ctx, "Auto reviewing retry without sandbox...", () => runAutoReview(action, ctx, config.reviewer, ctx.signal));
    if (reviewAllowed(review)) return { allow: true };

    if (reviewEscalatesToUser(review)) {
      const ok = await askUser(ctx, "Retry without sandbox?", formatSandboxFallbackUserPrompt(action, review.rationale));
      return ok ? { allow: true } : { allow: false, reason: "Retry without sandbox blocked by user" };
    }

    return { allow: false, reason: `Retry without sandbox blocked by auto review: ${review.rationale}` };
  }

  pi.registerTool({
    ...baseBash,
    label: "bash (auto-review)",
    async execute(
      toolCallId: string,
      params: BashToolInput,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<BashToolDetails | undefined>> {
      if (!config.enabled) {
        return createBashToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
      }

      const initialDecision = classifyBashCommand(params.command, ctx.cwd);
      const initialResolution = await resolveDecision(initialDecision, ctx);
      if (!initialResolution.allow) throw new Error(initialResolution.reason);

      const sandboxedBash = sandboxReady ? createBashToolDefinition(ctx.cwd, { operations: createSandboxedBashOps() }) : createBashToolDefinition(ctx.cwd);
      try {
        return await sandboxedBash.execute(toolCallId, params, signal, onUpdate, ctx);
      } catch (error) {
        if (!sandboxReady || !isSandboxDeniedError(error)) throw error;

        const retryAction = buildSandboxFallbackAction(params.command, ctx.cwd, sandboxDenialText(error));
        const retryResolution = await reviewSandboxFallback(retryAction, ctx);
        if (!retryResolution.allow) throw new Error(retryResolution.reason);

        if (ctx.hasUI) ctx.ui.notify("Sandbox blocked command; approved retry without sandbox", "info");
        return createBashToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
      }
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!config.enabled) return;
    if (isToolCallEventType("bash", event)) return;

    const decision = classifyFileOperationTool({ toolName: event.toolName, input: event.input as Record<string, unknown> }, ctx.cwd);
    if (!decision) return;

    const resolution = await resolveDecision(decision, ctx);
    if (resolution.allow) return;

    return { block: true, reason: resolution.reason };
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!config.enabled) {
      sandboxReady = false;
      updateStatus(ctx);
      return;
    }

    await tryEnableSandbox();
    updateStatus(ctx);
    if (ctx.hasUI) {
      ctx.ui.notify(sandboxReady ? "Auto review sandbox initialized" : `Auto review enabled; sandbox off${sandboxStatusNote ? ` (${sandboxStatusNote})` : ""}`, sandboxReady ? "info" : "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    if (!sandboxReady) return;
    try {
      await resetSandbox();
    } catch {
      // Ignore cleanup failures.
    } finally {
      sandboxReady = false;
    }
  });

  pi.registerCommand("auto-review", {
    description: "Control auto review mode: /auto-review [status|on|off|sandbox on|sandbox off]",
    getArgumentCompletions: (prefix: string) => {
      const items = ["status", "on", "off", "sandbox on", "sandbox off"].map((value) => ({ value, label: value }));
      const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on") {
        config = { ...config, enabled: true };
        if (config.sandbox.enabled) await tryEnableSandbox();
        updateStatus(ctx);
        ctx.ui.notify("Auto review enabled", "info");
        return;
      }

      if (arg === "sandbox on") {
        config = { ...config, enabled: true, sandbox: { ...config.sandbox, enabled: true } };
        await tryEnableSandbox();
        updateStatus(ctx);
        ctx.ui.notify(sandboxReady ? "Auto review and sandbox enabled" : `Auto review enabled; sandbox off${sandboxStatusNote ? ` (${sandboxStatusNote})` : ""}`, sandboxReady ? "info" : "warning");
        return;
      }

      if (arg === "sandbox off") {
        config = { ...config, sandbox: { ...config.sandbox, enabled: false } };
        if (sandboxReady) {
          await resetSandbox().catch(() => {});
        }
        sandboxReady = false;
        sandboxStatusNote = undefined;
        updateStatus(ctx);
        ctx.ui.notify("Auto review sandbox disabled", "info");
        return;
      }

      if (arg === "off") {
        config = { ...config, enabled: false };
        if (sandboxReady) {
          await resetSandbox().catch(() => {});
        }
        sandboxReady = false;
        sandboxStatusNote = undefined;
        updateStatus(ctx);
        ctx.ui.notify("Auto review disabled", "info");
        return;
      }

      if (arg && arg !== "status") {
        ctx.ui.notify("Usage: /auto-review [status|on|off|sandbox on|sandbox off]", "error");
        return;
      }

      const lines = [
        `Auto review: ${config.enabled ? "enabled" : "disabled"}`,
        `Reviewer: ${config.reviewer.modelProvider}/${config.reviewer.modelId}:${config.reviewer.reasoningEffort}`,
        `Sandbox: ${sandboxReady ? "on" : `off${sandboxStatusNote ? ` (${sandboxStatusNote})` : ""}`}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

function formatSandboxFallbackUserPrompt(action: ReviewAction, rationale: string): string {
  return [
    formatActionForUser(action, `Auto reviewer requested user approval for retry without sandbox: ${rationale}`),
    "",
    "This will run without the filesystem sandbox.",
  ].join("\n");
}

function autoReviewMessage(action: ReviewAction): string {
  if (action.kind === "initial_bash") return "Auto reviewing bash command...";
  if (action.kind === "path_write") return "Auto reviewing file write...";
  if (action.kind === "path_read") return "Auto reviewing file read...";
  if (action.kind === "path_search") return "Auto reviewing file search...";
  return "Auto reviewing tool call...";
}
