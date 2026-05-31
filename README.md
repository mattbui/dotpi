# dotpi

Personal configuration for [pi](https://github.com/earendil-works/pi), built around my terminal workflow.

The default approach is to build features I need here first before reaching for another extension. The goal is a small, simple setup that keeps the agent close to the terminal, editor, tmux, and git habits already in use.

The guiding idea is that current models are smart enough to do good work without a bloated system prompt. The extensions and prompts focus on minimal guidance, focused tools, and guardrails that make unsafe actions harder while staying out of the way for normal coding work.

## What's here

- `extensions/custom-editor` replaces the default input editor with a compact prompt UI, hardware cursor behavior, slash-command handling, and inline `@` / `@@` fuzzy pickers for files and lines.
- `extensions/auto-review` adds a protected mode for bash and file operations using local policy, model review for ambiguous actions, and sandboxed bash execution when available.
- `extensions/web.ts` registers web search and scrape tools backed by Tavily and Firecrawl.
- `extensions/commit.ts` adds a `/commit` workflow for turning current changes into focused commits, with marker state and cleanup support.
- `extensions/diff.ts` opens a revdiff tmux popup and brings captured annotations back into Pi.
- `extensions/auto-session-title.ts` names sessions from the first user message and mirrors that state into tmux.
- `extensions/notify.ts` rings the terminal bell and sends macOS notifications when a session finishes outside the current focus.
- `extensions/custom-footer.ts` renders the preferred footer: cwd, branch, permission mode, model, reasoning level, token/cost stats, context usage, and extension statuses.
- `extensions/reasoning-command.ts` adds `/reasoning` and `/thinking` controls for switching model reasoning level.
- `extensions/openai-codex-fast-mode.ts` adds `/fast` and injects OpenAI Codex priority service tier when enabled.
- `themes/` and `keybindings.json` hold the visual and input preferences that go with the extensions.
