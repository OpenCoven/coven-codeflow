# Amp CLI Recreation

A small, dependency-free Node CLI that mirrors the public Amp command surface.
Not the Sourcegraph Amp binary; it does not call Amp services. Behavior is
deterministic and local so workflows can be exercised end-to-end.

## Quickstart

```sh
npm test                                   # run the test suite
npm start                                  # enter the interactive REPL
npm run amp -- --help                      # full help
npm run amp -- -x "what is 2+2?"           # one-shot execute
echo "list markdown files" | npm run amp   # piped stdin
```

The `amp` bin is also installable: `npm link` then `amp`.

## Interactive mode

Running `amp` with no arguments in a terminal drops into a minimalist REPL.
Each line is sent as one execute turn in the current thread; results print
before the next prompt.

```
$ amp
amp 0.0.0-recreate — interactive mode. Type /exit or press Ctrl-D to quit, /help for slash commands.
> what is 2+2?
4
> /tools list
Bash         built-in  Executes the given shell command in the user's default shell
Read         built-in  Reads a UTF-8 text file from disk
...
> /exit
```

Slash commands:

- `/exit`, `/quit` — leave the REPL
- `/help` — list slash commands
- `/mode [smart|deep|rush|large]` — show or set the mode for later turns
- `/<subcommand> [args…]` — run any top-level subcommand (`/tools list`, `/threads list`, `/permissions list --builtin`, `/usage`, …)
- Ctrl-D — same as `/exit`

Slash-command arguments are tokenized like a shell line: bare words split on
whitespace, with `"…"` and `'…'` quoting and `\"` / `\'` escapes inside them.
Anything that does not start with `/` is sent to the model as a one-turn
prompt.

End a line with `\` to continue the prompt onto the next line; the
continuation prompt is `… `. Lines are joined with embedded newlines and
sent as a single turn when a line without a trailing `\` arrives:

```
> write a haiku about \
… the package manager \
… you detect
```

Line history is persisted to `${XDG_CONFIG_HOME:-~/.config}/amp/repl_history`
(up to 500 entries) and reloaded on the next session — press up-arrow to
recall prior prompts. Override the path with `AMP_REPL_HISTORY_FILE` or
disable persistence entirely with `AMP_REPL_HISTORY=0`.

Non-interactive contexts (piped stdin, redirected stdout, CI) skip the REPL
and fall back to one-shot execute or help. Pass `--execute` / `-x` or pipe
stdin to force one-shot mode from a terminal.

## Execute mode

```sh
amp -x "prompt"                            # answer once, exit
amp -x "see @README.md" </dev/null         # @file mentions resolved
amp -x "..." --stream-json                 # Claude-compatible JSONL
amp -x "..." --stream-json-thinking        # include thinking blocks
amp --stream-json-input -x "..." < msgs.jsonl
```

`@file` mentions accept relative, absolute, `@~/…`, and glob paths. Text files
are capped at 500 lines and 2 KB per line; binaries are skipped.

`--stream-json-thinking` implies `--stream-json`; `--stream-json-input`
requires `--stream-json`. Stream JSON input accepts text blocks and image blocks
with `source_path` file URLs or base64 `source` metadata.

## Scripts

| Script             | What it does                                  |
| ------------------ | --------------------------------------------- |
| `npm test`         | `node --test` over `test/cli.test.mjs`        |
| `npm start`        | Launch the interactive REPL                   |
| `npm run amp -- …` | Pass arbitrary args to the local `amp` binary |

## Implemented

Core
- `amp --help`, `amp --version`
- interactive REPL (no args in a TTY) with per-session thread continuity, persistent line history, and backslash multiline continuation
- `amp usage` local thread usage estimates
- execute mode: `amp -x` / `amp --execute`
- piped stdin combined with execute prompts
- `@file` references for relative, absolute, `@~/...`, and glob paths
- `@image` references for common image file paths with media metadata
- `--stream-json`, `--stream-json-thinking`, `--stream-json-input` with text and image content blocks
- `--settings-file <path>`
- `$ …` / `$$ …` shell mode in stdin prompts

Tools
- `amp tools list`
- `amp tools make --bash <name>`
- `amp tools show tb__<name>`
- `amp tools use tb__<name>`
- `AMP_TOOLBOX` PATH-like discovery with left-to-right precedence
- toolbox JSON/text describe parsing and schema display
- toolbox execute environment and JSON CLI flag input
- execute-mode toolbox invocation with permission checks
- stream-json `tool_use` / `tool_result` events and final-result permission denials for toolbox calls
- `amp.tools.disable` filtering for built-in, toolbox, and MCP names/globs

Permissions
- `amp permissions list --builtin`
- `amp permissions add <action> <tool> …`
- `amp permissions edit` (stdin)
- `amp permissions test <tool> …`
- workspace override support for `amp.permissions`

Config & MCP
- `amp config edit [--workspace]`
- `amp mcp add [--workspace] <name> -- <command> [args…]`
- `amp mcp list`, `amp mcp doctor`, `amp mcp approve <name>`
- `amp mcp oauth login|logout <name>`
- `settings.jsonc` loading with comments and trailing commas
- user/workspace/managed settings precedence; workspace approval gating
- `--mcp-config` precedence over same-named configured MCP servers
- `amp.mcpPermissions` allow/reject matching for command, args, URL servers
- MCP-backed rows in `amp tools list` via a bounded `tools/list` probe
- execute-mode `tools/call` for approved local MCP servers
- MCP `includeTools` filtering for configured local servers
- `${VAR_NAME}` expansion in MCP server config strings

Skills
- `amp skill add <local-path|git-url|github-owner/repo[/path]>`
- `amp skill list|show|remove`
- project/user discovery with project precedence
- `amp.skills.path` extra roots; `amp.skills.disableClaudeCodeSkills`
- skill-bundled `mcp.json` activation on reference

Plugins
- `amp plugins list`
- project `.amp/plugins/*.ts` and user `~/.config/amp/plugins/*.ts` discovery
- plugin `amp.registerTool(...)` discovery in `amp tools list` and stream-json init tools
- execute-mode invocation of plugin-registered tools by name
- plugin `agent.start` and `agent.end` handlers for execute-mode turns
- plugin `tool.call` handlers with `reject-and-continue` support
- plugin `tool.result` handlers that replace plugin tool output
- plugin `amp.registerCommand(...)` discovery and execution via `amp plugins commands|run`
- plugin command availability states: `enabled`, `disabled` with reason, and `hidden`

Threads
- execute-mode thread persistence under the Amp config directory
- `amp threads list|show|search|archive|continue|handoff|report`
- references via `@T-…` and `https://ampcode.com/threads/T-…`

Misc
- `amp agents list`
- execute-mode includes AGENTS.md guidance @file mentions outside fenced code blocks, with frontmatter `globs` filtering
- execute-mode includes subtree AGENTS.md guidance when referenced files are read
- `amp review` deterministic local summary with `.agents/checks` discovery
- local stubs for `login`, `update`

## Next slices

- full MCP stdio/SSE lifecycle, health checks, OAuth, and remote tool invocation
- broader plugin events, command reload semantics, and richer UI contexts
- git/GitHub skill installation sources
- JSONC/settings schema beyond MCP and permissions keys
- thread visibility, labels, maps, web sharing, remote workspace search
- SDK-compatible execute API
