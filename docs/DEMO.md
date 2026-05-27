# Coven Code Demo

A 15-20 minute end-to-end walkthrough of every shipped surface in this
repository. Designed to be driven by a coding agent on the user's behalf,
or run live by a human presenter.

The companion script `scripts/demo.sh` is the executable source of truth.
Every shell block in this document also appears there in the same order
with the same expected outputs. The script is presentation-only and is
not wired into `npm test`.

---

## Agent Instructions (read this first if you are an LLM)

You are driving this demo for the user. Follow these rules:

1. **Prefer the script over ad-hoc commands.** If the user says "run the
   demo" with no qualifier, run `npm run demo` once end-to-end and
   report results. Do not improvise commands that drift from what is
   documented here. The script opens a menu by default but
   auto-advances through every section when stdin is not a TTY, so
   invoking it from an agent subprocess will not hang — it runs
   straight through. To request only one section non-interactively,
   the user can run `npm run demo` with input like `5\nq\n` piped in,
   but the easier path is just `npm run demo -- --auto` for the full
   walk.

2. **Walk the sections in order if asked to narrate.** When the user
   asks for a guided walkthrough, run each section's commands in the
   listed order. Before each command, state in one sentence what it
   demonstrates. After each command, confirm the expected output shape
   matches (do not paste full output back unless asked).

3. **Stop and ask before any of these.** The demo is offline and writes
   only to a temporary `HOME`, so it is otherwise safe. But you must
   confirm before:
   - Running the demo against the user's real `HOME` instead of a
     `mktemp` directory (do not do this unless explicitly asked).
   - Installing the package globally (`coven-code-sdk install`) on
     the user's machine.
   - Modifying any committed file in this repo as part of the demo
     (the demo should write only to `$DEMO_HOME` and `$DEMO_HOME`
     subdirectories).

4. **The interactive panel TUI is the only surface you cannot drive.**
   It requires a real terminal and keyboard input. When you reach the
   TUI Appendix below, hand off to the user with the documented key
   sequences they should try. Do not attempt to spawn the TUI yourself
   in execute mode or stream-json mode — it will not work and you
   will hang the session.

5. **All other state is disposable.** The demo writes to a fresh
   `$DEMO_HOME = $(mktemp -d)`. To re-run cleanly, just re-invoke the
   script — it creates a new temp dir each time. To clean up an old
   run, the final section of the script prints the exact `rm -rf`
   command to use.

6. **What this demo proves.** That every advertised feature in the
   `README.md` "Implemented Surface" section actually works against
   the local deterministic fixture agent (`src/agent/fixture.mjs`),
   without needing an API key, network access, or a hosted Coven Code
   service.

7. **What this demo does NOT prove.** It does not prove behavior
   against a real hosted model, real remote MCP servers, real OAuth,
   or the panel TUI's rendering. Those paths exist in the code but
   are out of scope for an offline demo. If the user asks about them,
   point them at `docs/MCP-SKILLS-PLUGINS.md`, the `mcp oauth login`
   subcommand, and the TUI appendix below.

---

## How to Run the Demo

End-to-end (recommended):

```sh
npm run demo
```

This invokes `bash ./scripts/demo.sh`. The script opens with a
welcome banner listing the 12 sections and the sandboxed HOME it will
use, then drops into an interactive menu so the operator picks what
to see — no cognitive overload from a 12-section wall of output.

The menu accepts:

| Input    | Action                                                   |
| -------- | -------------------------------------------------------- |
| `1`-`12` | run one section by number                                |
| `a`      | run all sections in sequence, then print the scoreboard  |
| `t`      | type your own prompt and run one execute turn            |
| `s`      | list the files the demo wrote into the sandbox HOME      |
| `l`      | re-print the section table of contents (with `✓` marks)  |
| `?`      | show the menu help                                       |
| `q`      | quit (sandbox path printed so you can clean up or poke around) |

Each section starts with a short narration explaining what it proves,
runs its commands (the literal `coven-code …` shell line is printed in
magenta before each output), and closes with a green `✓ proved: …`
payoff and a `↳ see also:` pointer to the relevant doc. After every
section the menu re-displays the running counter (`3 / 12 sections
seen`) so the audience always knows where they are.

The menu reads input via `read -e` so backspace, arrow keys, and line
history work in any terminal that supports readline — including agent
shells. Direct invocation (`bash scripts/demo.sh`) works identically
if `npm` is unavailable.

To skip the menu and run every section straight through (for example
when capturing a transcript or showing the demo to yourself):

```sh
npm run demo -- --auto             # explicit flag
COVEN_DEMO_AUTO=1 npm run demo     # env var
npm run demo > /tmp/demo.log 2>&1  # non-TTY stdout auto-advances too
```

When stdin is not a TTY (CI, an agent subprocess, a piped run), the
script automatically runs in `--auto` mode so it never hangs.

Colors are emitted only when stdout is a TTY. Set `NO_COLOR=1` to
disable color in a terminal that supports it but where you would
rather have plain output (e.g., capturing for a markdown paste).

To inspect or modify the demo HOME after the run, set it explicitly:

```sh
COVEN_DEMO_HOME=/tmp/my-coven-demo npm run demo
```

To clean up:

```sh
rm -rf "$DEMO_HOME"   # the script prints the exact path at the end
```

---

## Section 0 — Sanity

**What this shows.** The CLI is installed and the local login path
works without any account or API key.

```sh
node ./bin/coven-code.mjs --version       # prints 0.0.1
node ./bin/coven-code.mjs --help          # full option and command reference
node ./bin/coven-code.mjs login           # printable instructions (no token yet)
node ./bin/coven-code.mjs login status    # auth_status: logged_out
```

The repo intentionally has no live-model API integration. `login` and
`login status` operate against a local `~/.config/coven-code/auth.json`
file; the demo never sets a real token. If the user wants to also see
the credential-storage path, run `COVEN_CODE_API_KEY=demo-token coven-code login`
out of band — that is not part of the offline demo because it muddies
the "no credentials" story.

## Section 1 — Execute Mode

**What this shows.** Single-turn answers, mode and reasoning-effort
selection, `@file` context references, and stdin combination.

```sh
coven-code -x "what is 2+2?"
coven-code --mode deep --reasoning-effort high -x "summarize this request"
coven-code -x "summarize @sample.md"
printf 'extra context from stdin\n' | coven-code -x "answer using the piped context"
```

The fixture agent echoes a deterministic envelope around the prompt so
you can see exactly how mode, reasoning, file refs, and stdin flow into
the agent's input message.

## Section 2 — Threads

**What this shows.** Threads are local records. They persist across
execute turns, carry labels and visibility, support continue/search,
and can emit diagnostic reports and reference maps.

```sh
coven-code --label demo --visibility workspace -x "kick off a labelled demo thread"
coven-code threads list
coven-code --continue T-<id> -x "follow up on the previous turn"
coven-code threads show T-<id>
coven-code threads visibility T-<id> private
coven-code threads map T-<id>
coven-code threads report T-<id>
coven-code threads search "demo"
coven-code threads archive T-<id>
```

The script captures the first listed thread id into `$THREAD_ID` and
substitutes it into the subsequent commands.

## Section 3 — Stream JSON

**What this shows.** Structured JSONL output suitable for SDKs and
frontends, including thinking blocks and multi-turn JSONL input.

```sh
coven-code -x "what is 2+2?" --stream-json
coven-code -x "demonstrate reasoning" --stream-json --stream-json-thinking
coven-code -x 'kickoff' --stream-json --stream-json-input < messages.jsonl
```

`messages.jsonl` contains two `user` messages; the agent processes them
in order after the kickoff prompt.

## Section 4 — Permissions

**What this shows.** The default policy ships sensible allow/ask rules
for common shell commands, and operators can add and test their own.

```sh
coven-code permissions list
coven-code permissions add allow Bash command.name git
coven-code permissions test Bash command.name git
coven-code permissions list
```

Each rule is keyed by tool name plus a nested field path. `test`
prints the matched rule and source (user vs builtin) so you can see
exactly which rule wins.

## Section 5 — Tools and Toolbox

**What this shows.** Built-in tools, scaffolding a new toolbox tool,
running it directly, and pointing the CLI at a workspace-local
toolbox root with `--toolbox`.

```sh
coven-code tools list                                  # built-ins
coven-code tools make --bash demo_tool                 # writes ~/.config/coven-code/tools/demo_tool
coven-code tools list                                  # now includes tb__demo_tool
coven-code tools show tb__demo_tool
coven-code tools use tb__demo_tool --only output
coven-code --toolbox ./workspace-toolbox tools list    # workspace-local toolbox
coven-code --toolbox ./workspace-toolbox tools show tb__local_tool
```

The `--only output` flag is two args (`--only output`), not
`--only-output`. The script uses the correct form.

## Section 6 — Skills

**What this shows.** Skill discovery from built-ins and a workspace
skill root via `--skills`.

```sh
coven-code skill list
coven-code skill show building-skills
coven-code --skills ./workspace-skills skill list
coven-code --skills ./workspace-skills skill show release-checklist
```

A skill is just a directory with a `SKILL.md` whose YAML frontmatter
declares `name` and `description`. The script writes a minimal
`release-checklist` skill so the workspace-root case has something to
show.

## Section 7 — MCP

**What this shows.** Adding a stdio MCP server, approving it, and
running the health doctor — all without contacting a real remote
server.

```sh
coven-code mcp list                                                    # (none)
coven-code mcp add demo-server -- node -e "process.stdout.write('hi')" # harmless stdio command
coven-code mcp list                                                    # demo-server listed, approved at user scope
coven-code mcp approve demo-server                                     # workspace approval
coven-code mcp doctor                                                  # probes the server
```

The `--` separator is required so the spec parser knows where the
server name ends and the command begins. `mcp doctor` actually spawns
the configured command and waits for the MCP handshake; the harmless
command we use exits immediately, which the doctor reports as
"ok 0 tools."

For live remote MCP servers, see `docs/MCP-SKILLS-PLUGINS.md` and the
`coven-code mcp oauth login --server-url ... --client-id ... --client-secret ...`
flow. That path is intentionally out of scope for this offline demo.

## Section 8 — Plugins

**What this shows.** A project plugin in `.coven-code/plugins/*.ts`
registers a tool and a command. After reload, the new tool appears in
`tools list` and in the stream-json initialization message, proving it
is wired into the agent's runtime catalog.

```sh
# Plugin file (.coven-code/plugins/demo.ts):
export default function (covenCode) {
  covenCode.registerTool({
    name: 'demo_status',
    description: 'Returns a deterministic status string for the demo plugin',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: 'text', text: 'demo-plugin: ok' }] };
    },
  });
  covenCode.registerCommand(
    'demo-hello',
    { title: 'Demo Hello', description: 'Greets the operator from the demo plugin' },
    async () => 'hello from the demo plugin',
  );
}
```

```sh
coven-code plugins list
coven-code plugins reload
coven-code tools list                                # demo_status now appears as 'plugin'
coven-code -x "list available tools" --stream-json | head -1
```

The `head -1` line is the most important one: the init message's
`tools` array contains `demo_status`, confirming the plugin tool is
visible to the agent loop, not just to `tools list`.

## Section 9 — SDK

**What this shows.** Both the `coven-code-sdk` install helper and the
package's module exports (`execute`, `threads`, etc.).

```sh
node ./bin/coven-code-sdk.mjs        # prints usage for the install helper
```

A tiny consumer (`sdk-demo.mjs`) imports from `src/sdk.mjs` and
streams an execute turn:

```js
import { execute, threads } from '<repo>/src/sdk.mjs';

const threadId = await threads.new({ cwd: process.cwd() });
for await (const message of execute({ prompt: 'demonstrate the SDK path' })) {
  if (message.type === 'assistant') {
    console.log('assistant:', message.message?.content?.[0]?.text);
  }
  if (message.type === 'result') {
    console.log('result:', message.result);
  }
}
```

```sh
node sdk-demo.mjs
```

This proves the SDK shells out to `coven-code --stream-json` under the
hood and reshapes the JSONL into the documented event stream.

## Section 10 — Diagnostics

**What this shows.** Local-only diagnostic commands that are useful in
day-to-day operation but do not require model access.

```sh
coven-code usage                # thread/turn counts and token estimates
coven-code review               # configured local review checks (none by default)
coven-code ide connect          # IDE integration status
coven-code agents-md list       # AGENTS.md guidance files discovered from cwd
coven-code update               # update check (skipped because of COVEN_CODE_SKIP_UPDATE_CHECK=1)
```

The script writes a minimal `AGENTS.md` into the demo workspace so the
`agents-md list` output is non-empty.

## Section 11 — Cleanup

The script prints the absolute path of the temp `HOME` it used, along
with the exact `rm -rf` command to remove it. The demo never writes
outside `$DEMO_HOME`.

---

## Appendix A — Panel TUI (human only)

The interactive panel TUI is the project's headline UI but cannot be
scripted (it owns the terminal, processes raw keys, and has no
non-interactive contract beyond the deterministic test hook
`COVEN_CODE_TUI_SCRIPTED=1`, which is reserved for tests, not demos).

For a live audience, run this section by hand in a normal terminal:

```sh
node ./bin/coven-code.mjs        # no arguments, in a TTY -> panel TUI
```

Things worth showing:

1. **Tabs.** The status bar shows `chat | lane | tools | threads | config | help`.
   Cycle through them.
2. **Slash menu.** Type `/` in the composer to open the slash command
   palette with live filtering. Tab completes the selection.
3. **`/help`.** Lists built-in slash commands.
4. **`/mode`.** Shows the active agent mode (`smart`, `deep`, `rush`,
   `large`) and lets you change it.
5. **`/reasoning`.** Inspects or changes reasoning effort.
6. **`/lane refresh`, `/lane status`, `/lane diff`.** Loads the current
   worktree, branch, changed files, and a diff summary into the lane
   panel.
7. **`/lane harness <smart|deep|rush|large|next>`.** Switches the active
   lane harness.
8. **`/lane verify`.** Runs the detected verification command for the
   lane and keeps its output in the panel.
9. **`/new` and `/continue`.** Start a fresh thread or resume one.
10. **`/queue`.** Queues a follow-up prompt while the current turn is
    still running.

To exit cleanly, the standard kill key for `neo-blessed` apps works
(`Ctrl-C`).

If a demo cannot use a real TTY (e.g., recorded over an SSH pipeline
without a pty), fall back to the classic readline REPL instead — it
composes with shell pipelines and is fully scriptable:

```sh
COVEN_CODE_REPL=1 COVEN_CODE_REPL_HISTORY=0 coven-code
```

---

## Appendix B — What to do if the demo fails

The script uses `set -euo pipefail`, so any non-zero exit immediately
stops the run and the failing command is visible in the last printed
`$ ...` banner.

Common failure modes:

- **`node: command not found`** — `package.json` requires Node 24+.
  Check `node --version`.
- **`Unknown tool: tb__demo_tool`** — a previous failed run left state
  in `$DEMO_HOME`. The script always creates a fresh temp HOME, so
  just re-run.
- **`Unknown mcp command: ...`** — you're on an older CLI than this
  doc was written against. Pull the repo to head and re-run.
- **`Plugin tool execute handler is required`** — the plugin file was
  edited away from the documented shape. Restore it from this doc or
  `scripts/demo.sh`.

If any other command fails, capture the full output and the path of
the temp HOME (printed in section 11) and share both. The temp HOME
contains all settings, threads, plugins, and skills that the demo
generated, which is enough to reproduce the failure offline.
