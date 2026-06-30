/**
 * Commit workflow command.
 *
 * `/commit` creates a marker in Pi's conversation tree, sends a focused commit prompt
 * whose instructions are tailored to parsed flags, and keeps a footer/widget reminder
 * active until the context is cleared. `/commit clear` can optionally summarize the commit attempt before
 * navigating back to the pre-commit conversation point.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CUSTOM_TYPE = "commit-mode";
const MARKER_LABEL = "commit-start";
const WIDGET_ID = "commit-mode";
const DECISION_TOOL_NAME = "commit_confirm";
const VALID_FLAGS = new Set(["staged", "split", "push"]);

const COMMIT_PROMPT = `Prepare git commit(s) for $SCOPE.
$DIFF_INSTRUCTION
$PRESENTATION_INSTRUCTION

Commit style:
- Format: \`type(scope): imperative lowercase subject\`
- Types: \`feat\`, \`fix\`, \`chore\`, \`docs\`, \`refactor\`, \`test\`; use \`deps\` for dependency updates
- Use \`repo\` only for repo-wide changes
- Avoid generic scopes unless the repo uses them
$SPLIT_INSTRUCTION
- For large changes, include a concise multiline body with bullets

$DECISION_INSTRUCTION

Always run \`git push\` separately from other commands.
Only stop and ask before committing or pushing if conflicts exist, unsafe/sensitive files are involved, the target branch/remote is unclear, or any operation would be destructive. Never force-push or do risky/destructive actions without explicit confirmation.$EXTRA_INSTRUCTION`;

const SUMMARY_INSTRUCTIONS = `Summarize this commit context concisely.

Start with one sentence describing the commit attempt, for example: "User tried to commit the current changes."

Then include only the relevant points below:
- parsed flags and user instructions
- detected changes
- staging/grouping plan
- proposed commit message(s)
- commits created, with hashes if available
- whether anything was pushed and to which branch
- any unresolved issue or follow-up

Omit tool details, file-by-file diffs, and implementation commentary.`;

const REVISE_RESULT_TEXT = "User wants to discuss/revise before committing. Stop here and wait for the user's input.";
const COMMIT_DECISION_TITLE = "Commit and push?";

type CommitMarker = {
  entryId: string;
  createdAt?: number;
};

type Token = {
  value: string;
  index: number;
};

type ParsedCommitArgs =
  | {
      ok: true;
      flags: string[];
      extraPrompt: string;
    }
  | {
      ok: false;
      error: string;
    };

function getCommitEntryData(entry: unknown): { event?: unknown; createdAt?: unknown; markerId?: unknown; clearedAt?: unknown } | undefined {
  if (!entry || typeof entry !== "object") return undefined;

  const maybeEntry = entry as { type?: unknown; customType?: unknown; data?: unknown };
  if (maybeEntry.type !== "custom" || maybeEntry.customType !== CUSTOM_TYPE) return undefined;
  if (!maybeEntry.data || typeof maybeEntry.data !== "object") return undefined;

  return maybeEntry.data as { event?: unknown; createdAt?: unknown; markerId?: unknown; clearedAt?: unknown };
}

function deriveMarkerFromCurrentBranch(ctx: ExtensionContext): CommitMarker | undefined {
  let activeMarker: CommitMarker | undefined;

  for (const entry of ctx.sessionManager.getBranch()) {
    const data = getCommitEntryData(entry);
    if (!data) continue;

    if (data.event === "set") {
      activeMarker = {
        entryId: entry.id,
        createdAt: typeof data.createdAt === "number" ? data.createdAt : undefined,
      };
      continue;
    }

    if (data.event === "clear" && activeMarker) {
      if (typeof data.markerId !== "string" || data.markerId === activeMarker.entryId) {
        activeMarker = undefined;
      }
    }
  }

  return activeMarker;
}

function syncCommitWidget(ctx: ExtensionContext, marker: CommitMarker | undefined): void {
  if (!ctx.hasUI) return;

  if (marker) {
    ctx.ui.setWidget(
      WIDGET_ID,
      (_tui, theme) =>
        new Text(`${theme.fg("warning", "commit mode")} ${theme.fg("dim", "• /commit clear to clean up commit context")}`, 0, 0),
    );
  } else {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }
}

function startCommitSummarizingWidget(ctx: ExtensionContext): (() => void) | undefined {
  if (!ctx.hasUI) return undefined;

  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frameIndex = 0;

  const render = () => {
    const frame = frames[frameIndex % frames.length];
    frameIndex++;
    ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => new Text(theme.fg("dim", `${frame} Summarizing commit context...`), 0, 0));
  };

  render();
  const interval = setInterval(render, 120);
  return () => clearInterval(interval);
}

function isDefaultTreeVisibleEntry(entry: unknown): entry is { id: string; type: string } {
  if (!entry || typeof entry !== "object") return false;

  const maybeEntry = entry as { id?: unknown; type?: unknown };
  if (typeof maybeEntry.id !== "string" || typeof maybeEntry.type !== "string") return false;

  return !["label", "custom", "model_change", "thinking_level_change", "session_info"].includes(maybeEntry.type);
}

function findVisibleMarkerLabelTarget(ctx: ExtensionContext, markerId: string): string | undefined {
  let foundMarker = false;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (!foundMarker) {
      if (entry.id === markerId) foundMarker = true;
      continue;
    }

    if (!isDefaultTreeVisibleEntry(entry)) continue;

    const label = ctx.sessionManager.getLabel(entry.id);
    if (!label || label === MARKER_LABEL) return entry.id;
  }

  return undefined;
}

function findEntryBeforeMarker(ctx: ExtensionContext, markerId: string): string | undefined {
  let previousId: string | undefined;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.id === markerId) return previousId;
    previousId = entry.id;
  }

  return undefined;
}

function ensureMarkerLabels(pi: ExtensionAPI, ctx: ExtensionContext, marker: CommitMarker): void {
  const visibleLabelTargetId = findVisibleMarkerLabelTarget(ctx, marker.entryId);
  if (visibleLabelTargetId && ctx.sessionManager.getLabel(visibleLabelTargetId) !== MARKER_LABEL) {
    pi.setLabel(visibleLabelTargetId, MARKER_LABEL);
  }
}

function tokenizeArgs(args: string): Token[] {
  const tokens: Token[] = [];
  const regex = /\S+/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(args)) !== null) {
    tokens.push({ value: match[0], index: match.index });
  }

  return tokens;
}

function parseCommitArgs(args: string): ParsedCommitArgs {
  const trimmed = args.trim();
  if (!trimmed) return { ok: true, flags: [], extraPrompt: "" };

  const tokens = tokenizeArgs(args);
  const flags: string[] = [];
  let promptStart: number | undefined;

  for (const token of tokens) {
    if (promptStart === undefined && VALID_FLAGS.has(token.value)) {
      flags.push(token.value);
      continue;
    }

    if (promptStart === undefined) {
      promptStart = token.index;
      continue;
    }

    if (VALID_FLAGS.has(token.value)) {
      return {
        ok: false,
        error: `Flag "${token.value}" appears after freeform prompt text. Put flags before additional instructions.`,
      };
    }
  }

  return {
    ok: true,
    flags,
    extraPrompt: promptStart === undefined ? "" : args.slice(promptStart).trim(),
  };
}

function buildCommitPrompt(parsed: Extract<ParsedCommitArgs, { ok: true }>): string {
  const flagSet = new Set(parsed.flags);
  const scope = flagSet.has("staged") ? "the staged changes only" : "the working tree changes";
  const diffInstruction = flagSet.has("staged")
    ? "Inspect only staged changes. Check recent commits only for style/scope. Do not include unstaged or untracked changes unless explicitly asked."
    : "Inspect git status, staged changes, unstaged changes, untracked files, and recent commits.";
  const presentationInstruction = flagSet.has("push")
    ? "Show detected changes, staging plan, and proposed commit message(s)."
    : "Show detected changes, staging plan, and proposed commit message(s), AFTER that call `commit_confirm`.";
  const splitInstruction = flagSet.has("split")
    ? "- Group changes by intent and scope, committing unrelated groups separately"
    : "- Prefer a single focused commit unless the changes clearly need separation";
  const decisionInstruction = flagSet.has("push")
    ? flagSet.has("staged")
      ? "Then commit the staged changes and push without calling `commit_confirm`."
      : "Then stage as needed, commit, and push without calling `commit_confirm`."
    : `After \`commit_confirm\`:
- proceed/proceed_with_feedback: stage, commit, and push without more confirmation
- revise: stop and wait for user input`;
  const extraInstruction = parsed.extraPrompt ? `\n\nAdditional user instruction:\n${parsed.extraPrompt}` : "";

  return COMMIT_PROMPT.replace("$SCOPE", scope)
    .replace("$DIFF_INSTRUCTION", diffInstruction)
    .replace("$PRESENTATION_INSTRUCTION", presentationInstruction)
    .replace("$SPLIT_INSTRUCTION", splitInstruction)
    .replace("$DECISION_INSTRUCTION", decisionInstruction)
    .replace("$EXTRA_INSTRUCTION", extraInstruction);
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function setCommitDecisionToolActive(pi: ExtensionAPI, active: boolean): void {
  const activeTools = pi.getActiveTools();
  const hasTool = activeTools.includes(DECISION_TOOL_NAME);

  if (active && !hasTool) {
    pi.setActiveTools([...activeTools, DECISION_TOOL_NAME]);
    return;
  }

  if (!active && hasTool) {
    pi.setActiveTools(activeTools.filter((tool) => tool !== DECISION_TOOL_NAME));
  }
}

async function createMarker(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<CommitMarker | undefined> {
  const createdAt = Date.now();

  pi.appendEntry(CUSTOM_TYPE, {
    event: "set",
    createdAt,
  });

  const entryId = ctx.sessionManager.getLeafId();
  if (!entryId) {
    notify(ctx, "Could not create commit marker", "error");
    return undefined;
  }

  const marker = { entryId, createdAt };
  ensureMarkerLabels(pi, ctx, marker);
  return marker;
}

async function chooseClearMode(ctx: ExtensionCommandContext): Promise<"clear" | "summarize" | "cancel"> {
  if (!ctx.hasUI) return "clear";

  const choice = await ctx.ui.select("Clean up commit context", [
    "Clear",
    "Summarize",
    "Cancel",
  ]);

  if (choice === "Summarize") return "summarize";
  if (choice === "Cancel" || choice === undefined) return "cancel";
  return "clear";
}

type CommitDecision =
  | { action: "proceed" }
  | { action: "proceed_with_feedback"; feedback: string }
  | { action: "revise" };

class CommitDecisionPrompt implements Component, Focusable {
  private readonly input = new Input();
  private _focused = false;

  onDone?: (decision: CommitDecision) => void;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    private readonly title: string,
    private readonly label: string,
    private readonly hint: string,
    private readonly border: (text: string) => string,
  ) {
    this.input.onSubmit = (value) => {
      const feedback = value.trim();
      this.onDone?.(feedback ? { action: "proceed_with_feedback", feedback } : { action: "proceed" });
    };
    this.input.onEscape = () => this.onDone?.({ action: "revise" });
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.onDone?.({ action: "revise" });
      return;
    }

    if (matchesKey(data, "enter")) {
      const feedback = this.input.getValue().trim();
      this.onDone?.(feedback ? { action: "proceed_with_feedback", feedback } : { action: "proceed" });
      return;
    }

    this.input.handleInput(data);
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const borderWidth = Math.max(1, width);
    const border = this.border("─".repeat(borderWidth));
    return [
      border,
      truncateToWidth(this.title, width),
      truncateToWidth(this.label, width),
      ...this.input.render(width),
      truncateToWidth(this.hint, width),
      border,
    ];
  }
}

function requestCommitDecisionAttention(pi: ExtensionAPI, ctx: ExtensionContext): void {
  pi.events.emit("notify:attention", {
    kind: "confirm",
    title: COMMIT_DECISION_TITLE,
    sessionName: pi.getSessionName() || ctx.sessionManager.getSessionName(),
  });
}

async function chooseCommitDecision(ctx: ExtensionContext): Promise<CommitDecision> {
  return ctx.ui.custom<CommitDecision>((tui, theme, _keybindings, done) => {
    const prompt = new CommitDecisionPrompt(
      theme.fg("accent", theme.bold(COMMIT_DECISION_TITLE)),
      theme.fg("muted", "Optional feedback:"),
      theme.fg("dim", "Enter to proceed • Add feedback to refine • Esc to cancel"),
      (text: string) => theme.fg("accent", text),
    );
    prompt.onDone = done;

    return {
      get focused() {
        return prompt.focused;
      },
      set focused(value: boolean) {
        prompt.focused = value;
      },
      render: (width) => prompt.render(width),
      invalidate: () => prompt.invalidate(),
      handleInput: (data) => {
        prompt.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  let marker: CommitMarker | undefined;

  function refresh(ctx: ExtensionContext, options: { backfillLabels?: boolean } = {}): void {
    marker = deriveMarkerFromCurrentBranch(ctx);
    if (marker && options.backfillLabels) ensureMarkerLabels(pi, ctx, marker);
    syncCommitWidget(ctx, marker);
    setCommitDecisionToolActive(pi, marker !== undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    refresh(ctx, { backfillLabels: true });
  });

  pi.on("session_tree", (_event, ctx) => {
    refresh(ctx, { backfillLabels: true });
  });

  pi.on("message_end", (_event, ctx) => {
    refresh(ctx, { backfillLabels: true });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    marker = undefined;
    syncCommitWidget(ctx, undefined);
    setCommitDecisionToolActive(pi, false);
  });

  pi.registerTool({
    name: DECISION_TOOL_NAME,
    label: "Commit Plan Decision",
    description: "Ask the user to approve, approve with feedback, or revise the commit plan.",
    promptSnippet: "Confirm the commit plan before staging, committing, and pushing.",
    promptGuidelines: [
      "ONLY call commit_confirm in commit mode AFTER showing detected changes, the staging/commit plan, and proposed commit message(s); do not call it for /commit push.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!marker) {
        return {
          isError: true,
          content: [{ type: "text", text: "commit_confirm is only available in commit mode." }],
          details: { action: "unavailable" },
        };
      }

      if (!ctx.hasUI) {
        return {
          isError: true,
          content: [{ type: "text", text: "commit_confirm requires interactive UI." }],
          details: { action: "unavailable" },
        };
      }

      requestCommitDecisionAttention(pi, ctx);
      const decision = await chooseCommitDecision(ctx);

      if (decision.action === "proceed") {
        return {
          content: [{ type: "text", text: "User approved. Proceed to add, commit, and push, no more confirmation." }],
          details: { action: "proceed" },
        };
      }

      if (decision.action === "proceed_with_feedback") {
        return {
          content: [
            {
              type: "text",
              text: `User approved with feedback. Apply this feedback, then add, commit, and push, no more confirmation:\n${decision.feedback}`,
            },
          ],
          details: { action: "proceed_with_feedback", feedback: decision.feedback },
        };
      }

      return {
        content: [{ type: "text", text: REVISE_RESULT_TEXT }],
        details: { action: "revise", feedback: "" },
      };
    },
  });

  pi.registerCommand("commit", {
    description: "Stage, commit, and push changes ([staged] [split] [push] [extra instruction...] | clear)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        throw new Error("/commit requires interactive mode");
      }

      const trimmed = args.trim();

      if (trimmed === "clear") {
        await ctx.waitForIdle();
        refresh(ctx);

        if (!marker) {
          notify(ctx, "No active commit marker", "warning");
          return;
        }

        const activeMarker = marker;
        const beforeMarkerId = findEntryBeforeMarker(ctx, activeMarker.entryId);
        const targetId = beforeMarkerId ?? activeMarker.entryId;

        const mode = await chooseClearMode(ctx);
        if (mode === "cancel") return;

        const stopSummarizingWidget = mode === "summarize" ? startCommitSummarizingWidget(ctx) : undefined;

        let result: { cancelled: boolean };
        try {
          result = await ctx.navigateTree(targetId, {
            summarize: mode === "summarize",
            customInstructions: mode === "summarize" ? SUMMARY_INSTRUCTIONS : undefined,
            replaceInstructions: mode === "summarize",
            label: mode === "summarize" ? "commit-summary" : undefined,
          });
        } finally {
          stopSummarizingWidget?.();
        }

        if (result.cancelled) {
          syncCommitWidget(ctx, marker);
          return;
        }

        if (!beforeMarkerId) {
          pi.appendEntry(CUSTOM_TYPE, {
            event: "clear",
            markerId: activeMarker.entryId,
            clearedAt: Date.now(),
          });
        }

        refresh(ctx);
        notify(ctx, "Commit context cleaned up", "info");
        return;
      }

      if (trimmed.startsWith("clear ")) {
        notify(ctx, "Usage: /commit clear", "error");
        return;
      }

      const parsed = parseCommitArgs(args);
      if (!parsed.ok) {
        notify(ctx, parsed.error, "error");
        return;
      }

      await ctx.waitForIdle();
      refresh(ctx);

      if (!marker) {
        marker = await createMarker(pi, ctx);
        syncCommitWidget(ctx, marker);
        setCommitDecisionToolActive(pi, marker !== undefined);
      } else {
        ensureMarkerLabels(pi, ctx, marker);
        notify(ctx, "commit marker already active; using existing marker", "info");
      }

      if (!marker) return;

      pi.sendUserMessage(buildCommitPrompt(parsed));
    },
  });
}
