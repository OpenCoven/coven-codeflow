# CLI Reference

## Entry Points

During development, run the CLI through npm:

```sh
npm run coven-code -- --help
npm run coven-code -- -x "what is 2+2?"
```

Installed package binaries:

```sh
coven-code --help
coven-code-sdk install
```

The direct local entrypoint is:

```sh
node ./bin/coven-code.mjs
```

## Help

`coven-code --help` prints the full option and command reference. The excerpt
below is verified against actual `--help` output by the test suite; regenerate
it with `node ./bin/coven-code.mjs --help` between the markers if it drifts.

<!-- BEGIN: coven-code --help -->
```text
Coven Code

Usage: coven-code [options] [command]

Run with no arguments in a terminal to enter the panel TUI. Set
COVEN_CODE_REPL=1 to use the classic readline REPL. Piped stdin becomes the
first interactive message when stdout is a TTY. Pass --execute or redirect
stdout to run a single turn and exit.

Options:
      --execute, -x [prompt]   Run one agent turn, print the final answer, and exit
      --stream-json            Emit structured JSONL in execute mode
      --stream-json-thinking   Include thinking blocks in stream JSON output
      --stream-json-input      Read one or more user messages as JSONL from stdin
      --dangerously-allow-all  Allow tool calls that would otherwise require approval
      --mcp-config <json>      Add an inline MCP server config for this run
      --settings-file <path>   Read user settings from a specific file
      --mode <name>            Agent mode: smart, deep, rush, or large
      --reasoning-effort <level>
                               Set reasoning effort for the active mode
      --label <name>           Add a label to the created or continued thread
      --visibility <level>     Thread visibility: private, public, workspace, group, or unlisted
      --archive                Archive the thread after the execute turn
      --continue [thread-id]   Continue the latest active thread or the specified thread
      --toolbox <path>         Use a PATH-like toolbox root for this run
      --skills <path>          Use a PATH-like skill root for this run
      --jetbrains              Connect to a JetBrains IDE
  -h, --help                   Show help
  -v, --version                Show version

Commands:
  login                        Print local login instructions
  update                       Check for updates
  usage                        Show local usage estimates
  review                       Run configured local review checks
  tools list|make|show|use     Manage built-in and toolbox tools
  permissions list             Show permission policy rules
  config edit [--workspace]    Open settings in $EDITOR
  ide connect                  Connect or inspect local IDE integration
  mcp add|list|doctor|approve|oauth
                               Manage MCP server settings
  skill list|show              Inspect discovered Coven Code agent skills
  plugins list|reload          Show and reload project and user plugin files
  threads list|show|search|archive|visibility|continue|map|report
                               Manage local thread records
  agents-md list               Show AGENTS.md guidance files used for this cwd
  agents list                  Alias for agents-md list

TUI lane commands:
  /lane refresh                Refresh worktree, branch, changed files, and diff summary
  /lane harness <name|next>    Select smart, deep, rush, or large for the lane
  /lane verify                 Run the detected verification command for the lane
  /lane status|diff            Show lane status or diff summary
```
<!-- END: coven-code --help -->

## Interactive Mode

Run with no arguments in a TTY:

```sh
coven-code
```

The default interactive surface is a full-screen `neo-blessed` panel TUI with a
transcript, tabs, compact status line, command palette, slash-command menu, and
composer. It keeps a current local thread and accepts slash commands:

```text
Coven Code 0.0.4
[chat]  lane   tools   threads   config   help    mode: smart   effort: high
--------------------------------------------------------------------------------
Ready. Type a prompt or /help.
--------------------------------------------------------------------------------
> /help
```

Supported interactive behaviors include:

- panel tabs for chat, lane, tools, threads, config, and help
- `/lane refresh` to load current worktree, branch, changed files, and diff summary
- `/lane harness <smart|deep|rush|large|next>` to select the active lane harness
- `/lane verify` to run the detected verification command and keep its output in the lane panel
- `/lane status` and `/lane diff` to inspect the visible lane model
- `/` opens a filtered command menu with details for built-ins, skills, and
  plugin commands
- Tab completes the selected slash command; Enter accepts it; Esc closes the menu
- command palette actions for common thread and tool workflows
- persistent line history
- `/new` to start a fresh thread
- `/continue` to resume a thread
- `/queue` to queue a follow-up prompt
- `/mode` to inspect or change the active mode
- `/reasoning` to inspect or change reasoning effort
- command aliases for tools, skills, plugins, threads, diagnostics, and IDE
  inspection
- multiline prompts with trailing backslash continuation

Use the classic readline REPL explicitly when a plain prompt is better for
scripts, demos, or compatibility:

```sh
COVEN_CODE_REPL=1 coven-code
```

Disable classic REPL history for demos or tests:

```sh
COVEN_CODE_REPL_HISTORY=0 coven-code
```

`COVEN_CODE_TUI_SCRIPTED=1` is a deterministic test and automation hook for
feeding newline-separated TUI input. It is not intended as a normal user mode.

## Execute Mode

Use `--execute` or `-x` for one turn and exit:

```sh
coven-code -x "what is 2+2?"
coven-code -x "summarize @README.md"
coven-code --continue T-example -x "continue this thread"
```

Piped stdin is combined with the prompt:

```sh
echo "list markdown files" | coven-code
echo "additional context" | coven-code -x "answer using this context"
```

`-x`, `--stream-json`, `--stream-json-input`, stdin piping, and subcommands
keep their existing noninteractive behavior; the panel TUI only changes the
bare no-argument TTY path.

## File, Image, Glob, and Thread References

Execute prompts can reference local context:

```sh
coven-code -x "summarize @README.md"
coven-code -x "inspect @docs/*.md"
coven-code -x "describe @image.png"
coven-code -x "compare this with @T-existing-thread"
coven-code -x "continue from @@search words"
```

Text references are capped to keep prompts bounded. Binary files are skipped
unless handled as supported media references.

## Stream JSON

Use `--stream-json` for structured JSONL suitable for frontends and SDKs:

```sh
coven-code -x "what is 2+2?" --stream-json
coven-code -x "inspect this" --stream-json --stream-json-thinking
```

Use `--stream-json-input` to read user messages from JSONL stdin:

```sh
coven-code --stream-json --stream-json-input < messages.jsonl
```

Stream JSON emits initialization, user, assistant, tool use, tool result, and
final result messages.

## Tools

```sh
coven-code tools list
coven-code tools show Bash
coven-code tools make --bash my-tool
coven-code tools use tb__my-tool
```

Built-in tools include `Bash`, `Read`, `Grep`, `glob`, `create_file`,
`edit_file`, `undo_edit`, `Task`, `oracle`, `librarian`, `painter`, `mermaid`,
`look_at`, `web_search`, `read_web_page`, `find_thread`, `finder`, and
`read_mcp_resource`.

## Permissions

```sh
coven-code permissions list
coven-code permissions list --builtin
coven-code permissions add allow Bash command.name git
coven-code permissions test Bash command.name git
```

Permission rules can allow or reject tool calls by tool name, action, command,
arguments, server names, URLs, and nested context fields.

## Threads

```sh
coven-code threads list
coven-code threads show T-example
coven-code threads search "query"
coven-code threads continue T-example -x "follow up"
coven-code threads archive T-example
coven-code threads visibility T-example workspace
coven-code threads map T-example
coven-code threads report T-example
```

Threads are local records that preserve prompts, labels, visibility, archive
state, diagnostic reports, and reference edges.

## Other Commands

```sh
coven-code login
coven-code update
coven-code usage
coven-code review
coven-code config edit
coven-code config edit --workspace
coven-code ide connect
coven-code agents-md list
```

`agents list` is an alias for `agents-md list`.
