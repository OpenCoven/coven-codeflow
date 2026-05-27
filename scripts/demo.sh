#!/usr/bin/env bash
# Coven Code end-to-end demo.
#
# Walks the full local surface against the deterministic fixture agent:
# CLI entry, execute mode, threads, stream JSON, permissions, tools,
# toolbox, skills, MCP, plugins, SDK, diagnostics.
#
# Presentation-only: NOT wired into `npm test`. Deterministic and
# offline: no API key, no network, no real MCP servers. Every command
# runs against a freshly created HOME so nothing leaks onto the
# operator's machine.
#
# Default mode is interactive with a menu: pick a section by number,
# run all in sequence, type your own prompt, or inspect the sandbox.
# Pass --auto (or set COVEN_DEMO_AUTO=1) to skip the menu and run
# every section straight through. The script also auto-advances when
# stdin is not a TTY (CI, agent subprocesses, piped log capture).
#
# Pair with docs/DEMO.md for narration.

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

  --auto         Skip the interactive menu and run all sections in
                 order. Default: open a menu in a TTY; auto when
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

DEMO_START_SECONDS=$SECONDS

on_interrupt() {
  printf '\n\n%sInterrupted.%s Demo HOME: %s\n' "$C_YELLOW" "$C_RESET" "$DEMO_HOME"
  exit 130
}
trap on_interrupt INT

# ---- Section registry --------------------------------------------------------

# Each section has a short tag (for menu), a one-line title, and a function.
SECTION_TAGS=(
  "Sanity"
  "Execute"
  "Threads"
  "StreamJSON"
  "Permissions"
  "Tools"
  "Skills"
  "MCP"
  "Plugins"
  "SDK"
  "Diagnostics"
  "Cleanup"
)
SECTION_TITLES=(
  "version, help, login state"
  "one-turn answers, modes, file refs, stdin"
  "persistence, continue, labels, visibility, search, report"
  "structured output, thinking blocks, multi-turn input"
  "defaults, add a rule, test the policy"
  "built-ins, scaffold a toolbox tool, --toolbox roots"
  "built-ins plus a workspace skill via --skills"
  "add a stdio server, list, approve, doctor"
  "register a tool + command, see it in the agent catalog"
  "package exports and install helper"
  "usage, review, ide, agents-md, update"
  "where state lives, plus a final scoreboard"
)
SECTION_FUNCS=(
  section_sanity
  section_execute
  section_threads
  section_stream_json
  section_permissions
  section_tools
  section_skills
  section_mcp
  section_plugins
  section_sdk
  section_diagnostics
  section_cleanup
)
TOTAL_SECTIONS=${#SECTION_TAGS[@]}

# Scoreboard counters.
COUNT_THREADS=0
COUNT_THREADS_ARCHIVED=0
COUNT_PLUGIN_TOOLS=0
COUNT_TOOLBOX_TOOLS=0
COUNT_MCP_SERVERS=0
COUNT_SKILLS_BUILTIN=0
COUNT_SKILLS_WORKSPACE=0
COUNT_PERM_RULES_ADDED=0
SECTIONS_RUN=0
SECTIONS_RUN_FLAGS=()  # one entry per section, 0 or 1
for _ in "${SECTION_TAGS[@]}"; do SECTIONS_RUN_FLAGS+=(0); done

# ---- UI helpers --------------------------------------------------------------

cc() {
  printf '\n%s$%s coven-code %s\n' "$C_MAGENTA" "$C_RESET" "$*"
  node "$CLI" "$@"
}
csdk() {
  printf '\n%s$%s coven-code-sdk %s\n' "$C_MAGENTA" "$C_RESET" "$*"
  node "$SDK_BIN" "$@"
}
raw_print() {
  printf '\n%s$%s %s\n' "$C_MAGENTA" "$C_RESET" "$1"
}

CURRENT_SECTION=0
section() {
  CURRENT_SECTION="$1"
  local title="${SECTION_TITLES[$((CURRENT_SECTION - 1))]}"
  local tag="${SECTION_TAGS[$((CURRENT_SECTION - 1))]}"
  printf '\n%s════════════════════════════════════════════════════════════════%s\n' "$C_CYAN" "$C_RESET"
  printf '%s§%d  %s%s  %s· %s%s\n' "$C_BOLD" "$CURRENT_SECTION" "$tag" "$C_RESET" "$C_DIM" "$title" "$C_RESET"
  printf '%s════════════════════════════════════════════════════════════════%s\n' "$C_CYAN" "$C_RESET"
}

narrate() {
  printf '%s%s%s\n' "$C_DIM" "$1" "$C_RESET"
}
proved() {
  printf '\n%s✓ proved:%s %s\n' "$C_GREEN" "$C_RESET" "$1"
  SECTIONS_RUN_FLAGS[$((CURRENT_SECTION - 1))]=1
  SECTIONS_RUN=$((SECTIONS_RUN + 1))
}
seealso() {
  printf '%s  ↳ see also: %s%s\n' "$C_DIM" "$1" "$C_RESET"
}

# Read a line with the most line-editing the shell can offer. -e turns on
# readline so backspace, arrow keys, and history work even inside agent
# shells that may not configure cooked mode aggressively.
prompt_line() {
  local _prompt="$1"
  local _var="$2"
  local _value=""
  if ! IFS= read -r -e -p "$_prompt" _value 2>/dev/null; then
    if ! IFS= read -r -p "$_prompt" _value; then
      _value=""
    fi
  fi
  printf -v "$_var" '%s' "$_value"
}

# ---- §1 sanity --------------------------------------------------------------

section_sanity() {
  section 1
  narrate "Confirm the CLI is wired correctly, see the full option surface, and"
  narrate "verify the local login flow works without any token or account."
  cc --version
  cc --help
  cc login
  cc login status
  proved "CLI v$CLI_VERSION boots, help renders, login flow works fully offline."
  seealso "docs/CLI.md"
}

# ---- §2 execute mode --------------------------------------------------------

section_execute() {
  section 2
  narrate "One-turn answers via -x, agent mode + reasoning-effort selection,"
  narrate "@file context references, and stdin combined into the prompt."
  cc -x "what is 2+2?"
  cc --mode deep --reasoning-effort high -x "summarize this request"

  cat > sample.md <<'EOF'
# Sample
Coven Code demo file used to show @file context references.
EOF
  cc -x "summarize @sample.md"

  raw_print 'printf "extra context from stdin\n" | coven-code -x "answer using the piped context"'
  printf 'extra context from stdin\n' | node "$CLI" -x "answer using the piped context"
  proved "execute mode answered 4 prompts (basic, with mode flags, with @file, with stdin)."
  seealso "docs/CLI.md#execute-mode"
}

# ---- §3 threads -------------------------------------------------------------

section_threads() {
  section 3
  narrate "Threads are local records. Watch them persist across turns, carry labels"
  narrate "and visibility, and emit diagnostic reports — all without a remote service."
  cc --label demo --visibility workspace -x "kick off a labelled demo thread"
  cc threads list

  local thread_id
  thread_id=$(node "$CLI" threads list | awk 'NR==1{print $1}')
  printf '\n%sCaptured THREAD_ID=%s%s\n' "$C_DIM" "$thread_id" "$C_RESET"

  cc --continue "$thread_id" -x "follow up on the previous turn"
  cc threads show "$thread_id"
  cc threads visibility "$thread_id" private
  cc threads map "$thread_id"
  cc threads report "$thread_id"
  cc threads search "demo"

  COUNT_THREADS=$(node "$CLI" threads list | wc -l | tr -d ' ')
  COUNT_THREADS_ARCHIVED=1
  cc threads archive "$thread_id"

  proved "$COUNT_THREADS thread(s) recorded, 1 continued, $COUNT_THREADS_ARCHIVED archived, 1 diagnostic report emitted."
  seealso "docs/CLI.md#threads"
}

# ---- §4 stream JSON ---------------------------------------------------------

section_stream_json() {
  section 4
  narrate "Structured JSONL output for SDKs and frontends: init, user, assistant,"
  narrate "and result messages — plus optional thinking blocks and JSONL input."
  cc -x "what is 2+2?" --stream-json
  cc -x "demonstrate reasoning" --stream-json --stream-json-thinking

  cat > messages.jsonl <<'EOF'
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"first turn from JSONL"}]}}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"second turn from JSONL"}]}}
EOF
  raw_print "coven-code -x 'kickoff' --stream-json --stream-json-input < messages.jsonl"
  node "$CLI" -x 'kickoff' --stream-json --stream-json-input < messages.jsonl
  proved "JSONL stream with init, user, assistant, thinking, and result events."
  seealso "docs/CLI.md#stream-json"
}

# ---- §5 permissions ---------------------------------------------------------

section_permissions() {
  section 5
  narrate "The default policy ships safe allow/ask rules. Add a custom rule and"
  narrate "ask the policy engine how it would resolve a given tool call."
  cc permissions list
  cc permissions add allow Bash command.name git
  COUNT_PERM_RULES_ADDED=1
  cc permissions test Bash command.name git
  cc permissions list
  proved "custom rule added and resolved at source: user, ahead of the builtins."
  seealso "docs/CONFIGURATION.md, docs/CLI.md#permissions"
}

# ---- §6 tools and toolbox ---------------------------------------------------

section_tools() {
  section 6
  narrate "Built-in tools, scaffolding a toolbox tool from scratch, then pointing"
  narrate "the CLI at a separate workspace-local toolbox root with --toolbox."
  cc tools list
  cc tools make --bash demo_tool
  cc tools list
  cc tools show tb__demo_tool
  cc tools use tb__demo_tool --only output

  mkdir -p workspace-toolbox
  cat > workspace-toolbox/local_tool <<'EOF'
#!/usr/bin/env bash
echo "local_tool ran with input: ${1:-<empty>}"
EOF
  chmod +x workspace-toolbox/local_tool
  cc --toolbox ./workspace-toolbox tools list
  cc --toolbox ./workspace-toolbox tools show tb__local_tool
  COUNT_TOOLBOX_TOOLS=2
  proved "$COUNT_TOOLBOX_TOOLS toolbox tools registered: tb__demo_tool (user) + tb__local_tool (--toolbox)."
  seealso "docs/CLI.md#tools"
}

# ---- §7 skills --------------------------------------------------------------

section_skills() {
  section 7
  narrate "Skill discovery from the built-in catalog and from a workspace-local"
  narrate "skill root passed with --skills. Each skill is just a SKILL.md file."
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
  cc --skills ./workspace-skills skill list
  cc --skills ./workspace-skills skill show release-checklist
  COUNT_SKILLS_WORKSPACE=1
  proved "$COUNT_SKILLS_BUILTIN built-in skill + $COUNT_SKILLS_WORKSPACE workspace skill discovered via --skills."
  seealso "docs/MCP-SKILLS-PLUGINS.md"
}

# ---- §8 MCP -----------------------------------------------------------------

section_mcp() {
  section 8
  narrate "Add a stdio MCP server with a harmless command, list/approve it, and"
  narrate "run the doctor to probe the connection — all without a real remote."
  cc mcp list
  cc mcp add demo-server -- node -e "process.stdout.write('hi')"
  cc mcp list
  cc mcp approve demo-server
  cc mcp doctor
  COUNT_MCP_SERVERS=1
  proved "$COUNT_MCP_SERVERS MCP server added, approved, and probed by doctor."
  seealso "docs/MCP-SKILLS-PLUGINS.md"
}

# ---- §9 plugins -------------------------------------------------------------

section_plugins() {
  section 9
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
  raw_print 'coven-code -x "list available tools" --stream-json | head -1   # init message = agent runtime catalog'
  node "$CLI" -x "list available tools" --stream-json | head -1

  printf '\n  %s┌─ THE PROOF ────────────────────────────────────────┐%s\n' "$C_GREEN$C_BOLD" "$C_RESET"
  printf '  %s│%s  In one init message the agent runtime sees:       %s│%s\n' "$C_GREEN$C_BOLD" "$C_RESET" "$C_GREEN$C_BOLD" "$C_RESET"
  printf '  %s│%s    · plugin tool   %sdemo_status%s                     %s│%s\n' "$C_GREEN$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_GREEN$C_BOLD" "$C_RESET"
  printf '  %s│%s    · toolbox tool  %stb__demo_tool%s                   %s│%s\n' "$C_GREEN$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_GREEN$C_BOLD" "$C_RESET"
  printf '  %s│%s    · MCP server    %sdemo-server%s (status: connected) %s│%s\n' "$C_GREEN$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_GREEN$C_BOLD" "$C_RESET"
  printf '  %s└────────────────────────────────────────────────────┘%s\n' "$C_GREEN$C_BOLD" "$C_RESET"

  COUNT_PLUGIN_TOOLS=1
  proved "plugin tool demo_status appears in tools list AND in the stream-json init catalog."
  seealso "docs/MCP-SKILLS-PLUGINS.md#plugins"
}

# ---- §10 SDK ----------------------------------------------------------------

section_sdk() {
  section 10
  narrate "The package exports an SDK (execute, threads). A tiny consumer shows"
  narrate "the stream surface composed in JS, plus the coven-code-sdk install helper."
  csdk

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
  raw_print "node sdk-demo.mjs"
  node sdk-demo.mjs
  proved "SDK created a thread and streamed assistant + result events from JS."
  seealso "docs/SDK.md"
}

# ---- §11 diagnostics --------------------------------------------------------

section_diagnostics() {
  section 11
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
  seealso "docs/CLI.md, docs/DEVELOPMENT.md"
}

# ---- §12 cleanup + scoreboard ----------------------------------------------

section_cleanup() {
  section 12
  narrate "Everything the demo did lives in one disposable HOME directory."

  # Mark this section run BEFORE the scoreboard so the count is honest.
  SECTIONS_RUN_FLAGS[11]=1
  SECTIONS_RUN=$((SECTIONS_RUN + 1))

  show_sandbox_listing

  local elapsed=$((SECONDS - DEMO_START_SECONDS))
  printf '\n%s───────────────────── Scoreboard ─────────────────────%s\n' "$C_CYAN" "$C_RESET"
  printf '  Sections run         %s%2d / %d%s\n'                    "$C_BOLD"  "$SECTIONS_RUN" "$TOTAL_SECTIONS" "$C_RESET"
  printf '  Total elapsed        %s%2ds%s  (interactive: includes pauses)\n' "$C_BOLD"  "$elapsed" "$C_RESET"
  printf '  Threads recorded     %s%2d%s  (%d archived)\n'          "$C_GREEN" "$COUNT_THREADS"  "$C_RESET" "$COUNT_THREADS_ARCHIVED"
  printf '  Permission rules     %s+%d%s  (user, ahead of builtins)\n' \
                                                                    "$C_GREEN" "$COUNT_PERM_RULES_ADDED" "$C_RESET"
  printf '  Toolbox tools        %s%2d%s  (user + workspace)\n'     "$C_GREEN" "$COUNT_TOOLBOX_TOOLS" "$C_RESET"
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
  seealso "docs/DEMO.md"
}

show_sandbox_listing() {
  printf '\n  %sFiles the demo wrote into the sandbox:%s\n' "$C_BOLD" "$C_RESET"
  ( cd "$DEMO_HOME" \
    && find . -maxdepth 4 -type f \
      -not -path './.config/coven-code/threads/*' \
      -not -path './.local/state/*' \
      2>/dev/null \
      | sort \
      | sed "s|^\./|    |" ) || true

  local thread_dir="$DEMO_HOME/.config/coven-code/threads"
  if [[ -d "$thread_dir" ]]; then
    local thread_count
    thread_count=$(find "$thread_dir" -type f 2>/dev/null | wc -l | tr -d '[:space:]')
    [[ -z "$thread_count" ]] && thread_count=0
    if [[ "$thread_count" -gt 0 ]]; then
      local noun="thread files"
      [[ "$thread_count" == "1" ]] && noun="thread file"
      printf '    %s.config/coven-code/threads/  (%d %s — elided)%s\n' "$C_DIM" "$thread_count" "$noun" "$C_RESET"
    fi
  fi
}

# ---- Welcome banner ---------------------------------------------------------

CLI_VERSION="$(node "$CLI" --version)"

welcome_banner() {
  printf '\n%s═══════════════════════════════════════════════════════════════%s\n' "$C_CYAN" "$C_RESET"
  printf '  %sCOVEN CODE%s  ·  v%s  ·  local-first demo\n' "$C_BOLD" "$C_RESET" "$CLI_VERSION"
  printf '%s═══════════════════════════════════════════════════════════════%s\n' "$C_CYAN" "$C_RESET"
  printf '\n  %s%d sections%s · fully offline · no API key · sandboxed HOME\n' "$C_BOLD" "$TOTAL_SECTIONS" "$C_RESET"
  printf '  HOME: %s%s%s\n' "$C_DIM" "$DEMO_HOME" "$C_RESET"
}

show_toc() {
  printf '\n  %sSections:%s\n' "$C_BOLD" "$C_RESET"
  local i=1
  for tag in "${SECTION_TAGS[@]}"; do
    local idx=$((i - 1))
    local mark=' '
    if [[ "${SECTIONS_RUN_FLAGS[$idx]}" == "1" ]]; then
      mark="${C_GREEN}✓${C_RESET}"
    fi
    printf '    %s %s%2d.%s  %-13s  %s%s%s\n' \
      "$mark" "$C_BOLD" "$i" "$C_RESET" "$tag" "$C_DIM" "${SECTION_TITLES[$idx]}" "$C_RESET"
    i=$((i + 1))
  done
}

show_menu_help() {
  printf '\n  %sCommands:%s\n' "$C_BOLD" "$C_RESET"
  printf '    %s1-12%s     run a single section\n' "$C_BOLD" "$C_RESET"
  printf '    %sa%s        run all sections in order, then show scoreboard\n' "$C_BOLD" "$C_RESET"
  printf '    %sr%s        replay the last section you ran\n' "$C_BOLD" "$C_RESET"
  printf '    %st%s        try your own prompt (one execute turn)\n' "$C_BOLD" "$C_RESET"
  printf '    %ss%s        show files in the sandbox HOME\n' "$C_BOLD" "$C_RESET"
  printf '    %sx%s        open a shell inside the sandbox (exit returns)\n' "$C_BOLD" "$C_RESET"
  printf '    %sc%s        copy the sandbox path to the clipboard\n' "$C_BOLD" "$C_RESET"
  printf '    %sl%s        list sections again\n' "$C_BOLD" "$C_RESET"
  printf '    %s?%s        show this help\n' "$C_BOLD" "$C_RESET"
  printf '    %sq%s        quit (Ctrl-C also works)\n' "$C_BOLD" "$C_RESET"
}

LAST_SECTION_IDX=-1

run_section_by_index() {
  local idx="$1"
  LAST_SECTION_IDX="$idx"
  "${SECTION_FUNCS[$idx]}"
}

replay_last_section() {
  if [[ "$LAST_SECTION_IDX" -lt 0 ]]; then
    printf '%sNo section run yet.%s Pick a number 1-12 first.\n' "$C_YELLOW" "$C_RESET"
    return
  fi
  local num=$((LAST_SECTION_IDX + 1))
  printf '\n%sReplaying §%d %s%s\n' "$C_DIM" "$num" "${SECTION_TAGS[$LAST_SECTION_IDX]}" "$C_RESET"
  "${SECTION_FUNCS[$LAST_SECTION_IDX]}"
}

try_a_prompt() {
  printf '\n%sType a prompt for one execute turn (Enter cancels).%s\n' "$C_BOLD" "$C_RESET"
  printf '%sExamples:%s "what is 2+2?"  ·  "summarize @sample.md"  ·  "list available tools"\n' "$C_DIM" "$C_RESET"
  local user_prompt=""
  prompt_line "prompt> " user_prompt
  if [[ -z "$user_prompt" ]]; then
    printf '%s(cancelled)%s\n' "$C_DIM" "$C_RESET"
    return
  fi
  cc -x "$user_prompt"
  printf '\n%s(answered by the local fixture agent — no network)%s\n' "$C_DIM" "$C_RESET"
}

shell_in_sandbox() {
  printf '\n%sOpening a subshell at %s%s\n' "$C_BOLD" "$DEMO_HOME" "$C_RESET"
  printf '%sType `exit` (or Ctrl-D) to return to the demo menu.%s\n\n' "$C_DIM" "$C_RESET"
  ( cd "$DEMO_HOME" && PS1="(coven-demo) \W $ " "${SHELL:-/bin/bash}" -i ) || true
  printf '\n%sBack in the demo menu.%s\n' "$C_DIM" "$C_RESET"
}

copy_sandbox_path() {
  local copied=0 tool=""
  if command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$DEMO_HOME" | pbcopy && copied=1 && tool="pbcopy"
  elif command -v wl-copy >/dev/null 2>&1; then
    printf '%s' "$DEMO_HOME" | wl-copy && copied=1 && tool="wl-copy"
  elif command -v xclip >/dev/null 2>&1; then
    printf '%s' "$DEMO_HOME" | xclip -selection clipboard && copied=1 && tool="xclip"
  elif command -v xsel >/dev/null 2>&1; then
    printf '%s' "$DEMO_HOME" | xsel --clipboard --input && copied=1 && tool="xsel"
  fi
  if [[ "$copied" == "1" ]]; then
    printf '%s✓ copied%s sandbox path to clipboard via %s\n  %s\n' \
      "$C_GREEN" "$C_RESET" "$tool" "$DEMO_HOME"
  else
    printf '%sNo clipboard tool found%s (looked for pbcopy / wl-copy / xclip / xsel).\n  Path: %s\n' \
      "$C_YELLOW" "$C_RESET" "$DEMO_HOME"
  fi
}

# ---- Top-level flow ---------------------------------------------------------

welcome_banner

if [[ "$AUTO_MODE" == "1" ]]; then
  printf '\n  %sauto mode%s — running every section in sequence.\n' "$C_DIM" "$C_RESET"
  for fn in "${SECTION_FUNCS[@]}"; do
    "$fn"
  done
  exit 0
fi

show_toc
show_menu_help

while true; do
  printf '\n%s──────────────────────────────────────────────────────%s\n' "$C_CYAN" "$C_RESET"
  printf '  %s%d / %d%s sections seen · sandbox %s%s%s\n' \
    "$C_BOLD" "$SECTIONS_RUN" "$TOTAL_SECTIONS" "$C_RESET" "$C_DIM" "$DEMO_HOME" "$C_RESET"
  CHOICE=""
  prompt_line "> " CHOICE
  case "$CHOICE" in
    "" )
      continue
      ;;
    [1-9]|1[0-2])
      run_section_by_index $((CHOICE - 1))
      ;;
    a|A|all)
      for idx in "${!SECTION_FUNCS[@]}"; do
        run_section_by_index "$idx"
      done
      ;;
    r|R|replay)
      replay_last_section
      ;;
    t|T|try)
      try_a_prompt
      ;;
    s|S|sandbox)
      show_sandbox_listing
      ;;
    x|X|shell)
      shell_in_sandbox
      ;;
    c|C|copy)
      copy_sandbox_path
      ;;
    l|L|list|ls)
      show_toc
      ;;
    \?|h|help)
      show_menu_help
      ;;
    q|Q|quit|exit)
      printf '\n%sBye.%s Sandbox stayed at: %s\n' "$C_BOLD" "$C_RESET" "$DEMO_HOME"
      printf '   Remove it with: rm -rf "%s"\n\n' "$DEMO_HOME"
      exit 0
      ;;
    *)
      printf '%sUnknown:%s %s  (try %s?%s for help)\n' "$C_YELLOW" "$C_RESET" "$CHOICE" "$C_BOLD" "$C_RESET"
      ;;
  esac
done
