# pi-auto-review

`pi-auto-review` adds three tool-access modes to Pi:

```text
full-access   Run tools directly without checks
auto-review   Run tools directly, but gate risky actions with policy/model review
auto-sandbox  Auto-review plus sandboxed bash execution
```

The default mode is `auto-sandbox` when the sandbox is available. If sandbox initialization fails, Pi falls back to `auto-review` and status shows `Sandbox: off (...)` with a short reason.

## Commands

```text
/auto-review status      Show reviewer, sandbox, and active mode
/auto-review off         Full access; run tools directly without checks
/auto-review no-sandbox  Run tools directly, but gate risky actions with policy/model review
/auto-review sandbox     Gate risky actions, then run bash inside a filesystem sandbox
```

## How it works

For `bash` calls:

```text
bash call
  -> local command policy
  -> auto reviewer if risky or unclear
  -> user approval if reviewer escalates
  -> sandboxed bash, when auto-sandbox is active
  -> retry review if the sandbox blocks the command
  -> retry without sandbox only if reviewer allows or user approves
```

For file operation tools:

```text
read/write/edit/grep/find/ls
  -> local path policy
  -> allow, deny, auto review, or user approval
```

The sandbox only wraps `bash`. File operation tools are protected before execution through Pi's `tool_call` hook.

## Policy summary

- Low-risk workspace reads/searches and common inspection commands are allowed.
- Risky or unclear shell commands and outside-workspace normal paths go to auto review.
- The reviewer can allow, deny, or escalate to the user for explicit approval.
- Sensitive user paths ask for user approval.
- Secret material, credential probing, destructive commands, and privilege escalation are denied before reviewer or sandbox.
- Retry without sandbox is only for `bash`, only after a sandbox denial or likely sandbox-denied output, and only after reviewer/user approval.

## Reviewer

The reviewer uses `openai-codex/gpt-5.3-codex-spark` with low reasoning by default. It receives no tools and returns only JSON:

```text
allow | deny | escalate_to_user
risk
rationale
```
