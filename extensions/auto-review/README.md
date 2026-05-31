# pi-auto-review

`pi-auto-review` adds a lightweight protected mode for Pi. It is intentionally simpler than Codex auto review: policy code handles obvious cases, a reviewer model judges ambiguous cases, and the bash sandbox constrains `bash` execution when available.

## Flow

`bash` calls:

```text
bash call
  -> local command policy
  -> auto reviewer if risky or unclear
  -> sandboxed bash
  -> sandbox fallback review if sandbox blocks the command
  -> unsandboxed retry only if fallback review allows it
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
- Sensitive user paths ask for user approval.
- Secret material, credential probing, destructive commands, and privilege escalation are denied before reviewer or sandbox.
- Sandbox fallback is only for `bash` and only after a sandbox denial.

The reviewer uses the current active model with minimal reasoning and receives no tools. It only returns JSON: allow/deny, risk, and rationale.
