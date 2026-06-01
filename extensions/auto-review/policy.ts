/**
 * Local policy classifier.
 *
 * This module is the first protection layer. It makes deterministic decisions
 * from command text and target paths before any model reviewer or sandbox runs.
 * The rules intentionally fail closed for credential material, destructive
 * commands, and privilege escalation, while sending ambiguous cases to the
 * auto reviewer. The sandbox remains the runtime enforcement layer for `bash`.
 */
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type ReviewKind = "initial_bash" | "sandbox_fallback" | "path_read" | "path_write" | "path_search";

export type ReviewAction = {
  kind: ReviewKind;
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  command?: string;
  path?: string;
  operation: "read" | "write" | "search" | "execute";
  reason: string;
  sandboxDenial?: string;
};

export type PolicyDecision =
  | { kind: "allow"; reason?: string }
  | { kind: "auto_review"; action: ReviewAction; reason: string }
  | { kind: "user_approval"; action: ReviewAction; reason: string }
  | { kind: "deny"; reason: string };

export type ReviewDecision = {
  outcome: "allow" | "deny" | "escalate_to_user";
  risk: RiskLevel;
  rationale: string;
};

export type FileOperationToolEvent = {
  toolName: string;
  input: Record<string, unknown>;
};

type PathSensitivity = "normal" | "workspace_sensitive" | "sensitive_user" | "secret_material";

const FILE_READ_TOOL_NAMES = new Set(["read"]);
const FILE_SEARCH_TOOL_NAMES = new Set(["grep", "find", "ls"]);
const FILE_WRITE_TOOL_NAMES = new Set(["edit", "write"]);

const SAFE_READ_COMMANDS = [
  /^\s*(pwd|true|false|whoami|date)\s*$/,
  /^\s*git\s+(status|diff|show|log|branch|rev-parse|ls-files|grep)\b/,
  /^\s*(ls|find|grep|rg|cat|sed|awk|head|tail|wc)\b/,
  /^\s*(npm|pnpm|yarn|bun)\s+(test|run\s+\S+|list|why|info)\b/,
  /^\s*(node|python3?|ruby|go|cargo|pytest|deno)\s+.*\b(--help|-h|--version|version)\b/,
];

const REVIEW_COMMANDS = [
  /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|upgrade|exec|dlx|create)\b/,
  /\b(pip|pipx|poetry|uv|cargo|go|brew)\s+(install|add|update|get|run)\b/,
  /\b(curl|wget|ssh|scp|rsync|git\s+push|git\s+commit)\b/,
  /\b(chmod|chown|ln|mv|cp|mkdir|touch)\b/,
  /\b(node|python3?|ruby|perl|bash|sh|zsh)\s+(-e|-c)\b/,
];

const DENY_COMMANDS = [
  /\bsudo\b/,
  /\bsu\s+-?\b/,
  /\bdoas\b/,
  /\bdd\s+.*\bof=/,
  /\bmkfs\b/,
  /\bdiskutil\s+(erase|partition|unmount|apfs)\b/,
  /\bsecurity\s+find-(generic|internet)-password\b/,
  /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh)\b/,
  /\bbase64\b[\s\S]*\b(?:curl|wget|nc|netcat|ssh|scp)\b/,
  /\brm\s+(-[^\s]*r[^\s]*f|-f[^\s]*r|--recursive[\s\S]*--force|--force[\s\S]*--recursive)\b/,
  /\bgit\s+(reset\s+--hard|clean\s+-[^\s]*f|checkout\s+--|restore\s+--staged)\b/,
];

const SECRET_PATH_PATTERNS = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.config\/gcloud\/application_default_credentials\.json$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.ssh\/id_[^/]+$/i,
  /(^|\/)[^/]+\.(pem|key|p12|pfx)$/i,
];

const SENSITIVE_USER_PATTERNS = [
  /(^|\/)\.ssh\/config$/i,
  /(^|\/)\.aws\/config$/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /(^|\/)\.(zshrc|zprofile|zlogin|bashrc|bash_profile|profile|config\/fish\/config\.fish)$/i,
  /(^|\/)\.config(\/|$)/i,
  /(^|\/)Library\/Application Support(\/|$)/i,
];

const WORKSPACE_SENSITIVE_PATTERNS = [
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)package-lock\.json$/i,
  /(^|\/)(pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i,
  /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/i,
];

export function classifyBashCommand(command: string, cwd: string): PolicyDecision {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) return { kind: "allow", reason: "empty command" };

  if (DENY_COMMANDS.some((pattern) => pattern.test(normalizedCommand))) {
    return { kind: "deny", reason: "Blocked high-risk shell command" };
  }

  const action: ReviewAction = {
    kind: "initial_bash",
    toolName: "bash",
    input: { command },
    cwd,
    command,
    operation: "execute",
    reason: "Shell command needs policy review",
  };

  if (SAFE_READ_COMMANDS.some((pattern) => pattern.test(normalizedCommand))) {
    return { kind: "allow", reason: "Low-risk shell command" };
  }

  if (REVIEW_COMMANDS.some((pattern) => pattern.test(normalizedCommand))) {
    return { kind: "auto_review", action, reason: "Shell command can change dependencies, network state, git state, or filesystem state" };
  }

  return { kind: "auto_review", action, reason: "Shell command is not in the low-risk allowlist" };
}

export function classifyFileOperationTool(event: FileOperationToolEvent, cwd: string): PolicyDecision | undefined {
  if (!FILE_READ_TOOL_NAMES.has(event.toolName) && !FILE_SEARCH_TOOL_NAMES.has(event.toolName) && !FILE_WRITE_TOOL_NAMES.has(event.toolName)) {
    return undefined;
  }

  const rawPath = getToolPath(event.toolName, event.input);
  const absolutePath = normalizePath(rawPath, cwd);
  const sensitivity = classifyPathSensitivity(absolutePath, cwd);
  const operation = FILE_WRITE_TOOL_NAMES.has(event.toolName) ? "write" : FILE_SEARCH_TOOL_NAMES.has(event.toolName) ? "search" : "read";
  const reviewKind: ReviewKind = operation === "write" ? "path_write" : operation === "search" ? "path_search" : "path_read";
  const action: ReviewAction = {
    kind: reviewKind,
    toolName: event.toolName,
    input: event.input,
    cwd,
    path: absolutePath,
    operation,
    reason: "File operation tool needs policy review",
  };

  if (sensitivity === "secret_material") {
    return { kind: "deny", reason: `Blocked ${operation} on secret material: ${displayPath(absolutePath)}` };
  }

  if (sensitivity === "sensitive_user") {
    return {
      kind: "user_approval",
      action,
      reason: `${event.toolName} targets a sensitive user path: ${displayPath(absolutePath)}`,
    };
  }

  if (!isInsidePath(absolutePath, cwd)) {
    return {
      kind: "auto_review",
      action,
      reason: `${event.toolName} targets a path outside the workspace: ${displayPath(absolutePath)}`,
    };
  }

  if (sensitivity === "workspace_sensitive") {
    return {
      kind: "auto_review",
      action,
      reason: `${event.toolName} targets a sensitive workspace path: ${displayPath(absolutePath)}`,
    };
  }

  return { kind: "allow", reason: "Path is inside workspace and not sensitive" };
}

export function buildSandboxFallbackAction(command: string, cwd: string, sandboxDenial: string): ReviewAction {
  return {
    kind: "sandbox_fallback",
    toolName: "bash",
    input: { command },
    cwd,
    command,
    operation: "execute",
    reason: "Sandbox denied the command; review unsandboxed retry",
    sandboxDenial,
  };
}

export function reviewAllowed(decision: ReviewDecision): boolean {
  return decision.outcome === "allow";
}

export function reviewEscalatesToUser(decision: ReviewDecision): boolean {
  return decision.outcome === "escalate_to_user";
}

export function formatActionForUser(action: ReviewAction, reason: string): string {
  const lines = [
    `Tool: ${action.toolName}`,
    `Reason: ${reason}`,
    `cwd: ${action.cwd}`,
  ];
  if (action.path) lines.push(`Path: ${displayPath(action.path)}`);
  if (action.command) lines.push(`Command: ${action.command}`);
  if (action.sandboxDenial) lines.push("", `Sandbox denial: ${action.sandboxDenial}`);
  return lines.join("\n");
}

export function extractFileOperationPath(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
  if (!FILE_READ_TOOL_NAMES.has(toolName) && !FILE_SEARCH_TOOL_NAMES.has(toolName) && !FILE_WRITE_TOOL_NAMES.has(toolName)) return undefined;
  return normalizePath(getToolPath(toolName, input), cwd);
}

function getToolPath(toolName: string, input: Record<string, unknown>): string {
  const pathValue = input.path;
  if (typeof pathValue === "string" && pathValue.trim()) return pathValue;
  if ((toolName === "grep" || toolName === "find" || toolName === "ls") && pathValue === undefined) return ".";
  return ".";
}

function classifyPathSensitivity(absolutePath: string, cwd: string): PathSensitivity {
  const normalized = toPosixPath(absolutePath);
  if (SECRET_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) return "secret_material";
  if (SENSITIVE_USER_PATTERNS.some((pattern) => pattern.test(normalized))) return "sensitive_user";
  if (isInsidePath(absolutePath, cwd) && WORKSPACE_SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized))) return "workspace_sensitive";
  return "normal";
}

function normalizePath(pathValue: string, cwd: string): string {
  const expanded = expandHome(pathValue.trim() || ".");
  return normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
}

function expandHome(pathValue: string): string {
  if (pathValue === "~") return homedir();
  if (pathValue.startsWith("~/")) return resolve(homedir(), pathValue.slice(2));
  return pathValue;
}

function isInsidePath(child: string, parent: string): boolean {
  const normalizedChild = normalize(child);
  const normalizedParent = normalize(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${sep}`);
}

function toPosixPath(pathValue: string): string {
  const home = normalize(homedir());
  const normalizedPath = normalize(pathValue);
  const display = normalizedPath === home || normalizedPath.startsWith(`${home}${sep}`) ? `~${normalizedPath.slice(home.length)}` : normalizedPath;
  return display.split(sep).join("/");
}

function displayPath(pathValue: string): string {
  return toPosixPath(pathValue);
}
