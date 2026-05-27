#!/usr/bin/env bash
# Coven Code end-to-end demo.
#
# Walks the full local surface against the deterministic fixture agent:
# CLI entry, execute mode, threads, stream JSON, permissions, tools,
# toolbox, skills, MCP, plugins, SDK, diagnostics.
#
# This script is presentation-only. It is NOT wired into `npm test`.
# It is deterministic and offline: no API key, no network, no real
# MCP servers. Every command runs against a freshly created HOME so
# the demo leaves no state behind on the operator's machine.
#
# Pair with docs/DEMO.md for narration. An agent driving the demo can
# follow either this script top-to-bottom or the section headers in
# docs/DEMO.md, which match section IDs here.

set -euo pipefail

# ---- Section: setup ----------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_ROOT/bin/coven-code.mjs"
SDK_BIN="$REPO_ROOT/bin/coven-code-sdk.mjs"
SDK_MODULE="$REPO_ROOT/src/sdk.mjs"

DEMO_HOME="${COVEN_DEMO_HOME:-$(mktemp -d -t coven-code-demo-XXXXXX)}"
export HOME="$DEMO_HOME"
export XDG_CONFIG_HOME="$DEMO_HOME/.config"
export XDG_DATA_HOME="$DEMO_HOME/.local/share"
export XDG_STATE_HOME="$DEMO_HOME/.local/state"
export COVEN_CODE_SKIP_UPDATE_CHECK=1
export COVEN_CODE_REPL_HISTORY=0

mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

cd "$DEMO_HOME"

section() {
  printf '\n\n=========================================================\n'
  printf '== %s\n' "$1"
  printf '=========================================================\n'
}

run() {
  printf '\n$ %s\n' "$*"
  "$@"
}

cc() {
  run node "$CLI" "$@"
}

# ---- Section: 0 sanity -------------------------------------------------------

section "0. Sanity: version, help, login state"
cc --version
cc --help
cc login
cc login status

# ---- Section: 1 execute mode -------------------------------------------------

section "1. Execute mode: one-turn answers, modes, file refs, stdin"
cc -x "what is 2+2?"
cc --mode deep --reasoning-effort high -x "summarize this request"

# Reference a real file in the demo workspace.
cat > sample.md <<'EOF'
# Sample
Coven Code demo file used to show @file context references.
EOF
cc -x "summarize @sample.md"

# Stdin gets combined with the prompt.
printf 'extra context from stdin\n' | run node "$CLI" -x "answer using the piped context"

# ---- Section: 2 threads ------------------------------------------------------

section "2. Threads: persistence, continue, labels, visibility, search, report"
cc --label demo --visibility workspace -x "kick off a labelled demo thread"
cc threads list

THREAD_ID=$(node "$CLI" threads list | awk 'NR==1{print $1}')
printf '\nCaptured THREAD_ID=%s\n' "$THREAD_ID"

cc --continue "$THREAD_ID" -x "follow up on the previous turn"
cc threads show "$THREAD_ID"
cc threads visibility "$THREAD_ID" private
cc threads map "$THREAD_ID"
cc threads report "$THREAD_ID"
cc threads search "demo"
cc threads archive "$THREAD_ID"

# ---- Section: 3 stream JSON --------------------------------------------------

section "3. Stream JSON: structured output, thinking blocks, multi-turn input"
cc -x "what is 2+2?" --stream-json
cc -x "demonstrate reasoning" --stream-json --stream-json-thinking

cat > messages.jsonl <<'EOF'
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"first turn from JSONL"}]}}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"second turn from JSONL"}]}}
EOF
run bash -c "node '$CLI' -x 'kickoff' --stream-json --stream-json-input < messages.jsonl"

# ---- Section: 4 permissions --------------------------------------------------

section "4. Permissions: defaults, add a rule, test the policy"
cc permissions list
cc permissions add allow Bash command.name git
cc permissions test Bash command.name git
cc permissions list

# ---- Section: 5 tools and toolbox -------------------------------------------

section "5. Tools: built-ins, scaffold a toolbox tool, run it, list, --toolbox"
cc tools list
cc tools make --bash demo_tool
cc tools list
cc tools show tb__demo_tool
run bash -c "node '$CLI' tools use tb__demo_tool --only output"

# Demonstrate --toolbox so a workspace can ship its own tools.
mkdir -p workspace-toolbox
cat > workspace-toolbox/local_tool <<'EOF'
#!/usr/bin/env bash
echo "local_tool ran with input: ${1:-<empty>}"
EOF
chmod +x workspace-toolbox/local_tool
run node "$CLI" --toolbox "$DEMO_HOME/workspace-toolbox" tools list
run node "$CLI" --toolbox "$DEMO_HOME/workspace-toolbox" tools show tb__local_tool

# ---- Section: 6 skills -------------------------------------------------------

section "6. Skills: built-ins and a workspace skill root via --skills"
cc skill list
cc skill show building-skills

mkdir -p workspace-skills/release-checklist
cat > workspace-skills/release-checklist/SKILL.md <<'EOF'
---
name: release-checklist
description: Walks the operator through Coven Code release readiness checks
---

# Release Checklist

1. Run `npm test`.
2. Confirm `node ./bin/coven-code.mjs --help` matches docs/CLI.md.
3. Tag the release once green.
EOF
run node "$CLI" --skills "$DEMO_HOME/workspace-skills" skill list
run node "$CLI" --skills "$DEMO_HOME/workspace-skills" skill show release-checklist

# ---- Section: 7 MCP ----------------------------------------------------------

section "7. MCP: add a stdio server, list, approve, doctor"
cc mcp list
# A harmless deterministic stdio server. `mcp doctor` will probe and
# report tool count; the command itself exits immediately.
cc mcp add demo-server -- node -e "process.stdout.write('hi')"
cc mcp list
cc mcp approve demo-server
cc mcp doctor

# ---- Section: 8 plugins ------------------------------------------------------

section "8. Plugins: write a project plugin, reload, see registered tool and command"
mkdir -p .coven-code/plugins
cat > .coven-code/plugins/demo.ts <<'EOF'
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
EOF
cc plugins list
cc plugins reload
cc tools list
# Confirm the plugin tool is wired into the agent's tool catalog at runtime.
printf '\n$ node "$CLI" -x "..." --stream-json | head -1   # init message lists the active tools\n'
node "$CLI" -x "list available tools" --stream-json | head -1

# ---- Section: 9 SDK ----------------------------------------------------------

section "9. SDK: package exports and install helper"
run node "$SDK_BIN"

cat > sdk-demo.mjs <<EOF
import { execute, threads } from '$SDK_MODULE';

const threadId = await threads.new({ cwd: process.cwd() });
console.log('created thread:', threadId);

for await (const message of execute({ prompt: 'demonstrate the SDK path' })) {
  if (message.type === 'assistant') {
    console.log('assistant:', message.message?.content?.[0]?.text);
  }
  if (message.type === 'result') {
    console.log('result:', message.result);
  }
}
EOF
run node sdk-demo.mjs

# ---- Section: 10 diagnostics -------------------------------------------------

section "10. Diagnostics: usage, review, ide, agents-md, update"
cat > AGENTS.md <<'EOF'
# Coven Code demo workspace
This AGENTS.md is intentionally minimal. `coven-code agents-md list`
discovers it from the current working directory.
EOF
cc usage
cc review
cc ide connect
cc agents-md list
cc update

# ---- Section: 11 cleanup -----------------------------------------------------

section "11. Cleanup"
printf '\nDemo HOME is at: %s\n' "$DEMO_HOME"
printf 'Remove it with:  rm -rf "%s"\n' "$DEMO_HOME"
printf '\nThe demo did not write to your real HOME or modify the repository.\n'
