# Coven Code Panel TUI Design

Date: 2026-05-25
Status: Approved for implementation planning
Project: `OpenCoven/coven-code`

## Summary

Bare `coven-code` should open a full-screen terminal UI instead of the current plain readline prompt. The TUI should make Coven Code feel like a real interactive coding surface while preserving the existing command engine, noninteractive modes, and slash-command behavior.

The selected direction is a panel-based TUI:

- Chat transcript as the main pane
- Composer at the bottom
- Status and shortcuts rail on the side
- Tabs for chat, tools, threads, config, and help
- Command palette for discoverable actions

## Goals

- Make interactive `coven-code` feel intentional, keyboard-first, and product-grade.
- Preserve current CLI compatibility for scripts, tests, and docs.
- Reuse existing command handlers rather than rewriting tool, thread, config, and skill behavior.
- Keep the first implementation focused on a strong single-session experience, not a multi-session orchestration cockpit.
- Leave clear seams for later streaming, tool event inspection, approval prompts, and multi-session control.

## Non-Goals

- Do not change `coven-code -x`, `--execute`, `--stream-json`, `--stream-json-input`, stdin piping, or command subcommands.
- Do not build the full multi-session control console in this pass.
- Do not introduce remote service dependencies.
- Do not replace the local deterministic runtime.
- Do not add decorative UI elements that do not improve operation or comprehension.

## Current State

The current interactive mode lives in `src/cli/repl.mjs` and uses Node's `readline/promises`.

It already supports:

- Plain prompt turns through `runInteractiveTurn`
- Slash commands
- `/mode`
- `/reasoning`
- `/queue`
- `/new`
- `/continue`
- `/editor`
- `/edit`
- Thread archive and visibility commands
- Skill and plugin command aliases
- REPL history

The TUI should keep those behaviors and adapt presentation/input handling around them.

## Proposed Architecture

Add a new TUI layer, likely `src/cli/tui.mjs`, that owns terminal rendering and keyboard interaction. It should call shared REPL/session operations instead of duplicating command logic.

Recommended structure:

- `src/cli/interactive-core.mjs`
  - Shared state transitions and command execution currently embedded in `repl.mjs`
  - Handles turns, slash commands, queue draining, mode/reasoning updates, and thread selection
- `src/cli/repl.mjs`
  - Keeps readline behavior as a fallback and for simple terminal environments
  - Delegates shared behavior to `interactive-core.mjs`
- `src/cli/tui.mjs`
  - Full-screen TUI renderer
  - Owns layout, focus, keybindings, palette, transcript rendering, status rail, and composer behavior
- `src/main.mjs`
  - Routes bare TTY interactive sessions to the TUI by default
  - Preserves existing execute and command routing

The TUI library should be small and terminal-focused. `blessed` is acceptable if it works cleanly with ESM and Node 20. If it creates friction, use a similarly small maintained package rather than hand-rolling terminal control.

## Default Routing

Interactive routing should become:

- If `parsed.execute` is true: use `runExecute`
- If stdin is piped and stdout is not a TTY: use `runExecute`
- If a command is provided: use `runCommand`
- If stdin/stdout are TTYs: use `runTuiInteractive`
- If TUI initialization fails or `NO_COLOR`/minimal terminal constraints make full-screen mode unsuitable: fall back to `runInteractive`

Add an escape hatch:

- `COVEN_CODE_REPL=1 coven-code` starts the existing readline REPL

This keeps the new UI default while preserving a debugging path.

## TUI Layout

The first implementation should have one primary screen with these areas:

### Header

Shows:

- Product name and version
- Mode
- Reasoning effort
- Runtime label
- Current thread status

### Tabs

Tabs are visual/focus regions, not separate command modes:

- `chat`: transcript and composer
- `tools`: available tools summary
- `threads`: active/latest thread controls
- `config`: current relevant settings
- `help`: keybindings and slash commands

### Transcript

Shows user prompts, assistant responses, command output, and errors in a scrollable main pane.

Transcript entries should distinguish:

- User messages
- Assistant messages
- Slash command results
- Tool or command output
- Errors

### Status Rail

Shows compact operational state:

- Thread id or "new thread"
- Mode
- Reasoning effort
- Queue count
- Tool count
- Config path or profile summary when useful

### Composer

Supports:

- Single-line prompt entry
- Multi-line entry when users insert newline intentionally
- Slash commands
- Submitting queued prompts after the current turn
- Clear status while a turn is running

## Keybindings

Minimum keybindings:

- `Enter`: submit composer
- `Shift-Enter` or `Alt-Enter`: insert newline if supported by the library/terminal
- `Tab`: cycle tabs or focus regions
- `Ctrl-P`: open command palette
- `Ctrl-N`: new thread
- `Ctrl-R`: cycle reasoning effort
- `Ctrl-M`: cycle mode
- `Ctrl-E`: open editor flow
- `Esc`: close palette or overlay
- `Ctrl-C`: graceful quit confirmation or immediate quit when idle

Slash commands remain available and should behave consistently with the old REPL.

## Command Palette

The command palette should expose common actions without forcing users to memorize slash commands:

- New thread
- Continue latest thread
- Open editor
- Edit previous prompt
- Toggle/cycle mode
- Toggle/cycle reasoning effort
- List tools
- List skills
- List plugins
- Open help
- Archive thread and quit

Palette commands should call the same shared command handlers used by slash commands.

## Error Handling

- Slash command errors should render in the transcript and keep the TUI alive.
- TUI initialization failure should fall back to readline with a concise warning.
- Terminal resize should redraw without losing transcript or composer contents.
- Command execution exceptions should preserve the current thread state when possible.
- Editor flow cancellation should return to the composer without submitting an empty prompt.

## Accessibility and Terminal Constraints

- Avoid emoji and decorative glyphs in the UI.
- Use text labels and simple ASCII-safe separators by default.
- Do not rely on color alone; labels must carry meaning.
- Keep all text readable on narrow terminals by truncating low-priority status fields before prompt or transcript text.
- Respect `NO_COLOR` by using plain styling if the selected library supports it.

## Testing Strategy

Use test-first implementation.

Required tests:

- Bare TTY routing chooses the TUI path.
- `COVEN_CODE_REPL=1` chooses the readline REPL path.
- Execute mode still prints `4` for `what is 2+2?`.
- `--stream-json` behavior is unchanged.
- Command subcommands still dispatch before interactive routing.
- Shared interactive command handling preserves `/mode`, `/reasoning`, `/queue`, `/new`, and `/continue` behavior.
- TUI command palette actions call the same underlying handlers as slash commands.

If the selected TUI library supports stable rendering in tests, add a lightweight layout smoke test. If not, test the TUI controller/state model instead of brittle terminal screenshots.

## Documentation Updates

Update:

- `README.md` interactive usage section
- `docs/CLI.md`
- `docs/DEVELOPMENT.md` if new test or TUI development instructions are needed

Docs should mention:

- Bare `coven-code` opens the TUI
- `COVEN_CODE_REPL=1 coven-code` starts the classic readline REPL
- Noninteractive command behavior is unchanged

## Implementation Plan Entry Point

The implementation plan should start by extracting shared interactive behavior from `src/cli/repl.mjs` into a testable module. After that, add TTY routing tests, introduce the TUI layer, and only then wire bare `coven-code` to the panel UI.

This avoids building the TUI around duplicated command logic and keeps the old REPL available as a fallback.
