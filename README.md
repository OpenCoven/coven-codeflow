# Coven Code

A small Node CLI for local Coven Code workflows. It runs deterministic local
command, thread, tool, MCP, skill, plugin, and SDK flows so integration behavior
can be exercised end-to-end without a hosted service.

## Quickstart

```sh
npm test
npm start
npm run coven-code -- --help
npm run coven-code -- -x "what is 2+2?"
echo "list markdown files" | npm run coven-code
```

The package exposes `coven-code` and `coven-code-sdk` bins.

## Documentation

- [CLI reference](docs/CLI.md) - commands, flags, interactive mode, execute mode, JSON streaming, and thread workflows
- [Configuration](docs/CONFIGURATION.md) - settings files, environment variables, precedence, and common examples
- [MCP, skills, and plugins](docs/MCP-SKILLS-PLUGINS.md) - extension points for tools, MCP servers, skills, and project plugins
- [SDK](docs/SDK.md) - package exports, install helper, execution API, permissions, and thread helpers
- [Development](docs/DEVELOPMENT.md) - repository layout, local checks, release notes, and safety expectations
- [Coven Dogfood Protocol](docs/DOGFOOD-PROTOCOL.md) - daily task packets, harness assignment, handoff, verification, retrospectives, and issue capture
- [Demo](docs/DEMO.md) - 15-20 minute end-to-end walkthrough of every shipped surface (`npm run demo`)

## Interactive Mode

Running `coven-code` with no arguments in a terminal starts the `neo-blessed`
panel TUI. Type `/` in the composer to open the slash-command menu with live
filtering and a details panel for commands, skills, and plugin actions.

```text
$ coven-code
Coven Code 0.0.4
/Users/example/project
[chat]  lane   tools   threads   config   help    mode: smart   effort: high
--------------------------------------------------------------------------------
Ready. Type a prompt or /help.
--------------------------------------------------------------------------------
>
```

The classic readline REPL remains available for scripts, demos, and compatibility:

```sh
COVEN_CODE_REPL=1 coven-code
```

Line history is stored at `${XDG_CONFIG_HOME:-~/.config}/coven-code/repl_history`.
Use `COVEN_CODE_REPL_HISTORY_FILE` to override the path or
`COVEN_CODE_REPL_HISTORY=0` to disable history in the classic REPL.

`COVEN_CODE_TUI_SCRIPTED=1` is reserved for deterministic tests and automation
that need to drive the TUI with newline-separated input.

## Execute Mode

```sh
coven-code -x "prompt"
coven-code -x "see @README.md" </dev/null
coven-code -x "..." --stream-json
coven-code -x "..." --stream-json --stream-json-input < msgs.jsonl
coven-code --continue T-... -x "continue a thread"
coven-code --toolbox ./toolbox -x "use tb__my_tool"
coven-code --skills ./skills -x "use the data-map skill"
```

Settings use the `covenCode.*` prefix. User settings live under
`${XDG_CONFIG_HOME:-~/.config}/coven-code/settings.json`; workspace settings
live under `.coven-code/settings.json`.

Useful settings and env vars:

- `covenCode.fuzzy.alwaysIncludePaths`
- `covenCode.tools.enable` / `covenCode.tools.disable`
- `covenCode.permissions`
- `covenCode.commands.allowlist`
- `covenCode.mcpServers`
- `covenCode.mcpPermissions`
- `covenCode.mcpRegistry.url`
- `covenCode.notifications.enabled`
- `covenCode.updates.mode`
- `covenCode.defaultVisibility`
- `COVEN_CODE_TOOLBOX`
- `COVEN_CODE_API_KEY`
- `COVEN_CODE_SKIP_UPDATE_CHECK`
- `COVEN_CODE_FORCE_BEL`
- `COVEN_CODE_CLI_PATH`
- `COVEN_CODE_HOME`

## Implemented Surface

Core:

- `coven-code --help`, `coven-code --version`
- panel TUI with transcript, lane status, tabs, status rail, composer, keyboard shortcuts, and command palette
- lane view for isolated worktree/branch context, harness selection, terminal output, changed files, diff summary, verification state, and PR/merge/cleanup status
- compatibility REPL with `/new`, `/continue`, `/queue`, `/mode`, `/reasoning`, persistent history, and multiline prompts
- command-palette aliases for thread archive, visibility, diagnostics, IDE, skills, plugins, and help
- one-shot execute mode with `-x` / `--execute`
- `@file`, glob, image, explicit thread, and `@@query` thread-search references
- `--stream-json`, `--stream-json-thinking`, `--stream-json-input`, and `--reasoning-effort`
- local persisted threads with labels, visibility, archive state, reports, and maps

Tools and permissions:

- built-in tools: `Bash`, `Read`, `Grep`, `glob`, `create_file`, `edit_file`, `undo_edit`, `Task`, `oracle`, `librarian`, `painter`, `mermaid`, `look_at`, `web_search`, `read_web_page`, `find_thread`, `finder`, and `read_mcp_resource`
- `coven-code tools list|make|show|use`
- toolbox discovery through `COVEN_CODE_TOOLBOX`, `--toolbox`, and `${XDG_CONFIG_HOME:-~/.config}/coven-code/tools`
- `coven-code permissions list|add|edit|test`
- delegated permission helpers receive `AGENT=coven-code` and `COVEN_CODE_THREAD_ID`

MCP, skills, and plugins:

- `coven-code mcp add|list|doctor|approve`
- remote MCP headers, OAuth credential storage in `~/.coven-code/oauth`, token refresh, Streamable HTTP sessions, and SSE fallback
- MCP registry enforcement that blocks unlisted servers and fails closed when the registry is unreachable
- skill discovery from configured roots, `.agents/skills`, legacy `.claude/skills` roots, and built-ins
- `coven-code skill list|show`
- project plugins from `.coven-code/plugins/*.ts` and user plugins from `${XDG_CONFIG_HOME:-~/.config}/coven-code/plugins/*.ts`
- plugin tools, commands, lifecycle events, configuration, status items, UI fallbacks, and helper APIs

SDK:

- `coven-code-sdk install [--force]`
- package root exports `execute`, `createUserMessage`, `createPermission`, and `threads`
- SDK execution streams local `coven-code --stream-json` messages
- SDK options map to CLI args for cwd, env, mode, reasoning effort, thinking, labels, visibility, archive, continuation, settings, toolbox, skills, MCP config, permissions, enabled tools, system prompt, logging, and permission bypass

## Development Checks

Run the full local verification gate before committing or publishing:

```sh
git diff --check
node ./bin/coven-code.mjs --help
node ./bin/coven-code.mjs -x "what is 2+2?"
npm test
```

The project is intentionally dependency-free at runtime. Keep new behavior
covered in `test/cli.test.mjs`, avoid hosted-service assumptions, and keep
examples deterministic.
