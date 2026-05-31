/**
 * Bash sandbox integration.
 *
 * This module adapts `@anthropic-ai/sandbox-runtime` to Pi's pluggable bash
 * operations. The sandbox is only used for `bash`; file operation tools are handled by
 * local policy in `policy.ts`. If the runtime cannot initialize, callers treat
 * sandbox as off and keep the policy/reviewer layer active.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

export type AutoReviewSandboxConfig = SandboxRuntimeConfig & {
  enabled: boolean;
};

export const DEFAULT_SANDBOX_CONFIG: AutoReviewSandboxConfig = {
  enabled: true,
  network: {
    allowedDomains: [
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", ".env", ".env.*", "*.pem", "*.key"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
  },
};

export async function initializeSandbox(config: AutoReviewSandboxConfig): Promise<boolean> {
  if (!config.enabled) return false;
  if (process.platform !== "darwin" && process.platform !== "linux") return false;

  const extended = config as AutoReviewSandboxConfig & {
    ignoreViolations?: Record<string, unknown>;
    enableWeakerNestedSandbox?: boolean;
  };

  await SandboxManager.initialize({
    network: config.network,
    filesystem: config.filesystem,
    ignoreViolations: extended.ignoreViolations,
    enableWeakerNestedSandbox: extended.enableWeakerNestedSandbox,
  });
  return true;
}

export async function resetSandbox(): Promise<void> {
  await SandboxManager.reset();
}

export function createSandboxedBashOps(): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      const wrappedCommand = await SandboxManager.wrapWithSandbox(command);
      return new Promise((resolve, reject) => {
        const child = spawn("bash", ["-c", wrappedCommand], {
          cwd,
          detached: process.platform !== "win32",
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        const killChild = () => {
          if (!child.pid) return;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            killChild();
          }, timeout * 1000);
        }

        const onAbort = () => killChild();
        signal?.addEventListener("abort", onAbort, { once: true });

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", (error) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        });
        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);

          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            resolve({ exitCode: code });
          }
        });
      });
    },
  };
}

export function isSandboxDeniedError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /sandbox|operation not permitted|permission denied|deny\(default\)|not allowed|network.*blocked|violat/i.test(text);
}

export function sandboxDenialText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim().slice(0, 3000);
}
