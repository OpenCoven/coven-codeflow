# Slash-First TUI Implementation Review

Date: 2026-05-26
Project: Coven Code
Status: Implemented and locally verified

## Bottom Line

This is a strong v1, not the best possible solution in the absolute sense. It is the right conservative solution for this branch because it keeps the existing Node/neo-blessed CLI stack, reuses the shared interactive command engine, preserves Coven-only branding, and adds focused coverage around the new slash-first behavior.

The main things to reconsider are future maintainability and deeper UX polish, not whether the current patch satisfies the requested interaction model.

## What Changed

- Added `src/cli/slash-commands.mjs` as the shared slash catalog source for built-ins, top-level shortcuts, plugin commands, and discovered skills.
- Extended `src/cli/interactive-core.mjs` so catalog-backed slash commands execute through the existing handler path.
- Made skill slash entries real: `/<skill>` shows skill details and `/<skill> <prompt>` submits a skill-guided prompt.
- Reworked `src/cli/tui.mjs` into a chat-first TTY experience with header, transcript, composer, compact status line, slash list, and command details overlay.
- Added slash menu state for open/close, filtering, selected index, details, completion, acceptance, cursor movement, and multiline composer behavior.
- Replaced placeholder TUI tab output with real summaries for tools, threads, config, and help.
- Updated skill discovery to support cwd-specific roots.
- Normalized early downstream pipe close handling with a SIGPIPE exit path.
- Adjusted local-agent prompt routing so global guidance containing review language does not override explicit codename/system-prompt tests.
- Updated README and CLI/development docs for the slash-first TUI behavior and manual smoke flow.
- Expanded tests for catalog construction, plugin visibility/availability, temp skill roots, TUI slash interaction, details rendering, narrow frames, tab summaries, and interactive-core slash behavior.

## Why This Is A Good Solution

- It matches the requested slash-first interaction model without copying outside branding.
- It avoids a runtime stack rewrite and honors the plan's no-new-dependency assumption.
- It centralizes slash command metadata so TUI and REPL help do not drift.
- It keeps command execution behind the existing shared interactive handler instead of creating a parallel command runner.
- It makes plugin and skill entries discoverable while respecting hidden and disabled command behavior.
- It is covered by both deterministic tests and a real manual TTY smoke path.

## Where To Reconsider

- `src/cli/tui.mjs` is now large and mixes model state, rendering, blessed wiring, summaries, and execution glue. If more TUI work lands, split it into model/controller/render/live-adapter modules.
- The dynamic slash catalog is rebuilt at launch and through the interactive-core safety path. That is fine now, but plugin-heavy setups may want explicit caching and invalidation.
- Skill execution currently injects skill guidance into the prompt. That is real and useful, but a future structured skill invocation contract could be more efficient and easier to reason about.
- Disabled plugin commands are visible and blocked, but the live UI could make disabled availability clearer with stronger styling and status text.
- Very small PTYs need more graceful fallback behavior. The manual smoke had to set rows and columns because expect defaults to a tiny pseudo-terminal.
- Long `/help` or detail output can push useful transcript context out of view. A future scroll/collapse affordance would improve dense command discovery.
- The current render tests are text-based and stable, but they do not replace periodic manual visual smoke tests for terminal layout drift.
- If Coven wants the richest possible terminal UX later, it may be worth evaluating Ink/react-blessed or a custom renderer. That should be a separate decision, because the current neo-blessed path is intentionally conservative.

## Verification Completed

- `git diff --check`
- `node --check` on touched runtime modules
- `node ./bin/coven-code.mjs --help`
- `node ./bin/coven-code.mjs -x "what is 2+2?"`
- `npm test -- --test-name-pattern "tui|slash|interactive core"`
- `npm test`
- Manual TTY smoke for `/`, `/mo`, arrows, Enter, Esc, `/help`, and `/exit`

## Recommended Follow-Ups

1. Keep this implementation as the v1 unless real user testing exposes a workflow miss.
2. Split TUI internals before adding another major interactive surface.
3. Add catalog caching only if plugin or skill discovery becomes measurably slow.
4. Design a structured skill invocation contract before expanding skill slash behavior further.
5. Add a tiny-terminal fallback and a lightweight visual smoke checklist for future TUI changes.
