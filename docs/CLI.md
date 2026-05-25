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

## Interactive Mode

Run with no arguments in a TTY:

```sh
coven-code
```

The default interactive surface is a full-screen panel TUI with a transcript,
tabs, status rail, command palette, and composer. It keeps a current local
thread and accepts slash commands:

```text
Coven Code 0.0.0-recreate
chat tools threads config help
--------------------------------------------------------------------------------
Ready. Type a prompt or /help.                         | thread: new thread
                                                        | mode: smart
                                                        | reasoning: high
--------------------------------------------------------------------------------
> /help
```

Supported interactive behaviors include:

- panel tabs for chat, tools, threads, config, and help
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
