# Custom Editor Extension

Custom Pi editor implementation

## What it changes

- Replaces Pi's default input editor with `CustomizedEditor`.
- Removes the default editor top/bottom border and draws a compact left prompt marker.
- Uses a beam-style hardware cursor and keeps the cursor positioned correctly while autocomplete/dropdowns are visible.
- Handles focus-in/focus-out terminal events so the cursor is hidden when the terminal loses focus.
- Changes Enter behavior:
  - Enter accepts an active autocomplete item.
  - Enter submits known slash commands.
  - Enter inserts a newline for normal text.
  - Alt+Enter submits the prompt.
- Prevents Tab from triggering autocomplete when the cursor token is empty.
- Customizes large paste marker rendering with compact previews.

## Large paste previews

Pi collapses large pastes into markers such as:

```text
[paste #1 +123 lines]
[paste #2 74028 chars]
```

This editor keeps those underlying markers intact, so submitted prompts still expand to the full pasted content, but renders extra context in the editor.

Line-based paste markers render as a small block preview using the first line and the last non-empty trailing line:

```text
[paste #1 +123 lines]
  first pasted line
  ...
  last meaningful pasted line
[/paste #1]
```

Character-based paste markers render inline with a short first-chunk preview:

```text
[paste #2 74028 chars `first pasted chars...`]
```

After new large paste markers are inserted, the editor also adds a real separator so the cursor lands in a natural place:

- line paste markers get a newline after the marker
- character paste markers get a space after the marker

## Inline `@` file/directory picker

Typing `@` at the start of a token opens a custom inline picker below the editor.

Examples:

```text
@
read @src
```

Does not trigger in the middle of a word:

```text
email@domain.com
```

Behavior:

- Uses `fzf` for fuzzy matching.
- Searches files and directories.
- Respects `.gitignore` by default when using `fd`.
- Inserts selected paths without the leading `@`.
- Inserts directories with a trailing `/` in both the link label and target.
- Highlights fuzzy matched characters.
- Esc closes the picker while leaving the typed `@query` intact.

The candidate command is read from `PI_INLINE_FZF_COMMAND`, with a built-in `fd`/`find` fallback.

## Inline `@@` line fzf picker

Typing `@@` at the start of a token opens a custom line picker below the editor.

Examples:

```text
@@TODO
explain @@function name
```

Behavior:

- Uses `rg` once to load project line results, then fuzzy-filters them as you type.
- Bare `@@` shows results immediately.
- Spaces are allowed inside the fuzzy query after the first character.
- `@@ ` closes/does not trigger the picker.
- Highlights fzf-matched characters.
- Enter inserts `path/to/file:line`.
- Esc closes the picker while leaving the typed `@@query` intact.
- Shows a widget error if `rg` is not installed.

The ripgrep source command is read from `PI_FZF_RG_COMMAND`, with a built-in `rg` default. Custom commands are not passed the query and should emit `file:line:column:text` lines.

## Files

- `index.ts` — main editor extension and key handling.
- `cursor.ts` — hardware cursor/focus helpers.
- `inline-file-fzf.ts` — single-`@` file and directory picker.
- `inline-lines-fzf.ts` — double-`@@` line fzf picker.
- `package.json` — local dependency on `fzf`.
