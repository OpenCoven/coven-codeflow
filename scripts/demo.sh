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
# Default mode is interactive: the script pauses between each section
# and waits for the operator to press Enter. Pass --auto (or set
# COVEN_DEMO_AUTO=1) to run straight through. The script also auto-
# advances when stdin is not a TTY (CI, agent subprocesses, piping
# to a log) so non-interactive invocations never hang.
#
# Pair with docs/DEMO.md for narration. An agent driving the demo can
# follow either this script top-to-bottom or the section headers in
# docs/DEMO.md, which match section indices here.

set -euo pipefail

# ---- Argument parsing --------------------------------------------------------

AUTO_MODE=0
for arg in "$@"; do
  case "$arg" in
    --auto|--no-pause)
      AUTO_MODE=1
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: bash scripts/demo.sh [--auto]

  --auto         Skip the per-section pause and run straight through.
                 Default: pause between sections in a TTY; auto when
                 stdin is piped (CI, agents, log capture).

Environment:
  COVEN_DEMO_HOME=<dir>   Use a specific HOME instead of $(mktemp -d).
  COVEN_DEMO_AUTO=1       Same as --auto.
  NO_COLOR=1              Disable ANSI color even in a TTY.
USAGE
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s (try --help)\n' "$arg" >&2
      exit 2
      ;;
  esac
done
if [[ "${COVEN_DEMO_AUTO:-0}" == "1" ]]; then
  AUTO_MODE=1
fi
if [[ ! -t 0 ]]; then
  AUTO_MODE=1
fi

# ---- Color palette (graceful fallback) --------------------------------------

if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]] && [[ "${TERM:-}" != "dumb" ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_CYAN=$'\033[36m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_MAGENTA=$'\033[35m'
  C_BLUE=$'\033[34m'
else
  C_RESET=""
  C_BOLD=""
  C_DIM=""
  C_CYAN=""
  C_GREEN=""
  C_YELLOW=""
  C_MAGENTA=""
  C_BLUE=""
fi

# ---- Environment setup -------------------------------------------------------

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

# Surface ctrl-c with the demo HOME so operators can poke around or clean up.
on_interrupt() {
  printf '\n\n%sInterrupted.%s Demo HOME: %s\n' "$C_YELLOW" "$C_RESET" "$DEMO_HOME"
  exit 130
}
trap on_interrupt INT

# ---- Sections registry (titles drive both the banners and the next-up prompt)

SECTIONS=(
  "Sanity              version, help, login state"
  "Execute mode        one-turn answers, modes, file refs, stdin"
  "Threads             persistence, continue, labels, visibility, search, report"
  "Stream JSON         structured output, thinking blocks, multi-turn input"
  "Permissions         defaults, add a rule, test the policy"
  "Tools               built-ins, scaffold a toolbox tool, --toolbox roots"
  "Skills              built-ins plus a workspace skill via --skills"
  "MCP                 add a stdio server, list, approve, doctor"
  "Plugins             register a tool + command, see it in the agent catalog"
  "SDK                 package exports and install helper"
  "Diagnostics         usage, review, ide, agents-md, update"
  "Cleanup             where state lives and how to remove it"
)
TOTAL_SECTIONS=${#SECTIONS[@]}
SECTION_INDEX=0
SECTION_TITLE=""

# Scoreboard counters incremented as the demo runs.
COUNT_THREADS=0
COUNT_THREADS_ARCHIVED=0
COUNT_PLUGIN_TOOLS=0
COUNT_TOOLBOX_TOOLS=0
COUNT_MCP_SERVERS=0
COUNT_SKILLS_BUILTIN=0
COUNT_SKILLS_WORKSPACE=0
COUNT_PERM_RULES_ADDED=0

# ---- UI helpers --------------------------------------------------------------

banner() {
  printf '\n%s═══════════════════════════════════════════════════════════════%s\n' "$C_CYAN" "$C_RESET"
  printf '  %sCOVEN CODE%s  ·  v%s  ·  local-first demo\n' "$C_BOLD" "$C_RESET" "$1"
  printf '%s═══════════════════════════════════════════════════════════════%s\n' "$C_CYAN" "$C_RESET"
  printf '\n'
  printf '  %s%d sections%s · fully offline · no API key · sandboxed HOME\n' "$C_BOLD" "$TOTAL_SECTIONS" "$C_RESET"
  if [[ "$AUTO_MODE" == "1" ]]; then
    printf '  %sauto mode%s — running all sections without pausing.\n' "$C_DIM" "$C_RESET"
  else
    printf '  press %sEnter%s between sections · %sq%s to quit · %s--auto%s for speed-run\n' \
      "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
  fi
  printf '  HOME: %s%s%s\n' "$C_DIM" "$DEMO_HOME" "$C_RESET"
  printf '\n  %sWhat you will see:%s\n' "$C_BOLD" "$C_RESET"
  local idx=1
  for entry in "${SECTIONS[@]}"; do
    printf '    %s%2d.%s  %s\n' "$C_DIM" "$idx" "$C_RESET" "$entry"
    idx=$((idx + 1))
  done
  printf '\n'
}

section() {
  if [[ "$SECTION_INDEX" -gt 0 ]] && [[ "$AUTO_MODE" != "1" ]]; then
    local next_idx=$SECTION_INDEX  # zero-indexed into SECTIONS for next-up
    local next_title="${SECTIONS[$next_idx]}"
    printf '\n%s─── §%d/%d done%s · %sEnter%s next: §%d %s%s%s · %sq%s quit ───\n> ' \
      "$C_DIM" "$SECTION_INDEX" "$TOTAL_SECTIONS" "$C_RESET" \
      "$C_BOLD" "$C_RESET" \
      "$((next_idx + 1))" "$C_CYAN" "${next_title%% *}" "$C_RESET" \
      "$C_BOLD" "$C_RESET"
    local answer=""
    if ! IFS= read -r answer; then
      answer="q"
    fi
    case "$answer" in
      q|Q|quit|exit)
        printf '\n%sHalted by operator after §%d.%s\n' "$C_YELLOW" "$SECTION_INDEX" "$C_RESET"
        printf 'Demo HOME: %s\n' "$DEMO_HOME"
        exit 0
        ;;
    esac
  fi
  SECTION_INDEX=$((SECTION_INDEX + 1))
  SECTION_TITLE="$1"
  local short="${1%% *}"
  printf '\n%s════════════════════════════════════════════════════════════════%s\n' "$C_CYAN" "$C_RESET"
  printf '%s§%d  %s%s\n' "$C_BOLD" "$SECTION_INDEX" "$1" "$C_RESET"
  printf '%s════════════════════════════════════════════════════════════════%s\n' "$C_CYAN" "$C_RESET"
}

# narration: dim italics-equivalent text under the section header
narrate() {
  printf '%s%s%s\n' "$C_DIM" "$1" "$C_RESET"
}

# proved: a green payoff line at the end of each section
proved() {
  printf '\n%s✓ proved:%s %s\n' "$C_GREEN" "$C_RESET" "$1"
}

run() {
  printf '\n%s$%s %s\n' "$C_MAGENTA" "$C_RESET" "$*"
  "$@"
}

cc() {
  run node "$CLI" "$@"
}

# ---- Welcome banner ----------------------------------------------------------

CLI_VERSION="$(node "$CLI" --version)"
banner "$CLI_VERSION"

if [[ "$AUTO_MODE" != "1" ]]; then
  printf '%sReady?%s Press %sEnter%s to begin (or %sq%s to bail).\n> ' \
    "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
  if ! IFS= read -r answer; then
    answer="q"
  fi
  case "$answer" in
    q|Q|quit|exit)
      printf '\nNever started. Demo HOME: %s\n' "$DEMO_HOME"
      exit 0
      ;;
  esac
fi

# ---- §1 sanity ---------------------------------------------------------------

section "${SECTIONS[0]}"
narrate "Check the CLI is wired correctly, see the full option surface, and confirm"
narrate "the local login flow works without any token or account."
cc --version
cc --help
cc login
cc login status
proved "CLI v$CLI_VERSION boots, help renders, login flow works fully offline."

# ---- §2 execute mode ---------------------------------------------------------

section "${SECTIONS[1]}"
narrate "One-turn answers via -x, agent mode and reasoning-effort selection, @file"
narrate "context references, and stdin combined into the prompt."
cc -x "what is 2+2?"
cc --mode deep --reasoning-effort high -x "summarize this request"

cat > sample.md <<'EOF'
# Sample
Coven Code demo file used to show @file context references.
EOF
cc -x "summarize @sample.md"

printf 'extra context from stdin\n' | run node "$CLI" -x "answer using the piped context"
proved "execute mode answered 4 prompts, including @file context and stdin merge."

# ---- §3 threads --------------------------------------------------------------

section "${SECTIONS[2]}"
narrate "Threads are local records. Watch them persist across turns, carry labels"
narrate "and visibility, and emit diagnostic reports — without a remote service."
cc --label demo --visibility workspace -x "kick off a labelled demo thread"
cc threads list

THREAD_ID=$(node "$CLI" threads list | awk 'NR==1{print $1}')
printf '\n%sCaptured THREAD_ID=%s%s\n' "$C_DIM" "$THREAD_ID" "$C_RESET"

cc --continue "$THREAD_ID" -x "follow up on the previous turn"
cc threads show "$THREAD_ID"
cc threads visibility "$THREAD_ID" private
cc threads map "$THREAD_ID"
cc threads report "$THREAD_ID"
cc threads search "demo"

# Snapshot the count BEFORE archiving so the scoreboard reflects what was created.
COUNT_THREADS=$(node "$CLI" threads list | wc -l | tr -d ' ')
COUNT_THREADS_ARCHIVED=1
cc threads archive "$THREAD_ID"

proved "$COUNT_THREADS thread(s) recorded, 1 continued, $COUNT_THREADS_ARCHIVED archived, 1 diagnostic report emitted."

# ---- §4 stream JSON ----------------------------------------------------------

section "${SECTIONS[3]}"
narrate "Structured JSONL output for SDKs and frontends. Init, user, assistant,"
narrate "and result messages — plus optional thinking blocks and JSONL input."
cc -x "what is 2+2?" --stream-json
cc -x "demonstrate reasoning" --stream-json --stream-json-thinking

cat > messages.jsonl <<'EOF'
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"first turn from JSONL"}]}}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"second turn from JSONL"}]}}
EOF
run bash -c "node '$CLI' -x 'kickoff' --stream-json --stream-json-input < messages.jsonl"
proved "JSONL stream with init, user, assistant, thinking, and result events."

# ---- §5 permissions ----------------------------------------------------------

section "${SECTIONS[4]}"
narrate "The default policy ships safe allow/ask rules. Add a custom rule and"
narrate "test how the policy resolves a tool call."
cc permissions list
cc permissions add allow Bash command.name git
COUNT_PERM_RULES_ADDED=1
cc permissions test Bash command.name git
cc permissions list
proved "custom rule added and resolved at source: user, ahead of the builtins."

# ---- §6 tools and toolbox ---------------------------------------------------

section "${SECTIONS[5]}"
narrate "Built-in tools, scaffolding a toolbox tool from scratch, and pointing the"
narrate "CLI at a separate workspace-local toolbox root via --toolbox."
cc tools list
cc tools make --bash demo_tool
cc tools list
cc tools show tb__demo_tool
run bash -c "node '$CLI' tools use tb__demo_tool --only output"

mkdir -p workspace-toolbox
cat > workspace-toolbox/local_tool <<'EOF'
#!/usr/bin/env bash
echo "local_tool ran with input: ${1:-<empty>}"
EOF
chmod +x workspace-toolbox/local_tool
run node "$CLI" --toolbox "$DEMO_HOME/workspace-toolbox" tools list
run node "$CLI" --toolbox "$DEMO_HOME/workspace-toolbox" tools show tb__local_tool
COUNT_TOOLBOX_TOOLS=2
proved "$COUNT_TOOLBOX_TOOLS toolbox tools registered: tb__demo_tool (user) + tb__local_tool (--toolbox)."

# ---- §7 skills ---------------------------------------------------------------

section "${SECTIONS[6]}"
narrate "Skill discovery from the built-in catalog and from a workspace-local"
narrate "skill root passed with --skills. Each skill is just a SKILL.md."
cc skill list
cc skill show building-skills
COUNT_SKILLS_BUILTIN=1

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
COUNT_SKILLS_WORKSPACE=1
proved "$COUNT_SKILLS_BUILTIN built-in skill + $COUNT_SKILLS_WORKSPACE workspace skill discovered via --skills."

# ---- §8 MCP ------------------------------------------------------------------

section "${SECTIONS[7]}"
narrate "Add a stdio MCP server with a harmless command, list/approve it, and"
narrate "run the doctor to probe the connection — all without a real remote."
cc mcp list
cc mcp add demo-server -- node -e "process.stdout.write('hi')"
cc mcp list
cc mcp approve demo-server
cc mcp doctor
COUNT_MCP_SERVERS=1
proved "$COUNT_MCP_SERVERS MCP server added, approved, and probed by doctor."

# ---- §9 plugins --------------------------------------------------------------

section "${SECTIONS[8]}"
narrate "A project plugin in .coven-code/plugins/*.ts registers a tool and a"
narrate "command. The init message of stream-json proves the agent sees them."
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
printf '\n%s$%s node "$CLI" -x "..." --stream-json | head -1   %s# init message lists the active tools%s\n' \
  "$C_MAGENTA" "$C_RESET" "$C_DIM" "$C_RESET"
node "$CLI" -x "list available tools" --stream-json | head -1
COUNT_PLUGIN_TOOLS=1
proved "plugin tool demo_status appears in tools list AND in the stream-json init catalog."

# ---- §10 SDK -----------------------------------------------------------------

section "${SECTIONS[9]}"
narrate "The package exports an SDK (execute, threads). A tiny consumer shows the"
narrate "stream surface composed in JS, plus the coven-code-sdk install helper."
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
proved "SDK created a thread and streamed assistant + result events from JS."

# ---- §11 diagnostics ---------------------------------------------------------

section "${SECTIONS[10]}"
narrate "Local-only diagnostics: usage estimates, review hooks, IDE bridge state,"
narrate "AGENTS.md discovery, and update channel — none require model access."
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
proved "5 diagnostic commands report status without any network round trip."

# ---- §12 cleanup + scoreboard ------------------------------------------------

section "${SECTIONS[11]}"
narrate "Everything the demo did lives in one disposable HOME directory."

printf '\n%s───────────────────── Scoreboard ─────────────────────%s\n' "$C_CYAN" "$C_RESET"
printf '  Sections run         %s%2d / %d%s\n'                "$C_BOLD"  "$TOTAL_SECTIONS" "$TOTAL_SECTIONS" "$C_RESET"
printf '  Threads recorded     %s%2d%s  (%d archived)\n'      "$C_GREEN" "$COUNT_THREADS"  "$C_RESET" "$COUNT_THREADS_ARCHIVED"
printf '  Permission rules     %s+%d%s  (user, ahead of builtins)\n' \
                                                              "$C_GREEN" "$COUNT_PERM_RULES_ADDED" "$C_RESET"
printf '  Toolbox tools        %s%2d%s  (user + workspace)\n' "$C_GREEN" "$COUNT_TOOLBOX_TOOLS" "$C_RESET"
printf '  Skills discovered    %s%2d%s  (built-in + workspace)\n' \
                                                              "$C_GREEN" "$((COUNT_SKILLS_BUILTIN + COUNT_SKILLS_WORKSPACE))" "$C_RESET"
printf '  MCP servers          %s%2d%s  (added, approved, probed)\n' \
                                                              "$C_GREEN" "$COUNT_MCP_SERVERS" "$C_RESET"
printf '  Plugin tools         %s%2d%s  (visible to the agent catalog)\n' \
                                                              "$C_GREEN" "$COUNT_PLUGIN_TOOLS" "$C_RESET"
printf '%s──────────────────────────────────────────────────────%s\n' "$C_CYAN" "$C_RESET"

printf '\n  %sSandbox:%s %s\n' "$C_BOLD" "$C_RESET" "$DEMO_HOME"
printf '  %sRemove:%s   rm -rf "%s"\n' "$C_BOLD" "$C_RESET" "$DEMO_HOME"
printf '\n  %sNothing was written outside the sandbox. Your real HOME is untouched.%s\n' "$C_DIM" "$C_RESET"
printf '\n%s✓ Demo complete.%s\n\n' "$C_GREEN$C_BOLD" "$C_RESET"
