# pi-auto-review

`pi-auto-review` adds a lightweight protected mode for Pi. It is intentionally simpler than Codex auto review: policy code handles obvious cases, a reviewer model judges ambiguous cases, and the bash sandbox constrains `bash` execution when available.

## Flow

`bash` calls:

```text
bash call
  -> local command policy
  -> auto reviewer if risky or unclear
  -> user approval if reviewer escalates
  -> sandboxed bash
  -> fallback review if sandbox blocks the command or output looks sandbox-denied
  -> unsandboxed retry if fallback review allows or user approves escalation
```

File operation tools:

```text
read/write/edit/grep/find/ls
  -> local path policy
  -> allow, deny, auto review, or user approval
```

The sandbox only wraps `bash`. File operation tools (`read`, `write`, `edit`, `grep`, `find`, and `ls`) are protected by Pi's `tool_call` hook before they execute.

## Commands

```text
/auto-review status
/auto-review on
/auto-review off
/auto-review sandbox on
/auto-review sandbox off
```

`/auto-review sandbox on` also turns auto review on, because the sandbox is part of the auto-review mode. If sandbox initialization fails, status shows `Sandbox: off (...)` with a short reason.

Footer modes:

```text
full access
auto-review
auto-review:sandbox
```

## Policy Summary

- Low-risk workspace reads/searches and common inspection commands are allowed.
- Risky or unclear shell commands and outside-workspace normal paths go to auto review.
- The reviewer can allow, deny, or escalate to the user for explicit approval.
- Sensitive user paths ask for user approval.
- Secret material, credential probing, destructive commands, and privilege escalation are denied before reviewer or sandbox.
- Sandbox fallback is only for `bash` and only after a sandbox denial or likely sandbox-denied command output.
- Retry outside the sandbox is auto reviewed; it runs only if the reviewer allows it or the user approves an escalation.

The reviewer uses the current active model with minimal reasoning and receives no tools. It only returns JSON: allow/deny/escalate_to_user, risk, and rationale.
