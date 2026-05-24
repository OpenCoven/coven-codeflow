export function printHelp() {
  console.log(`Usage: amp [options] [command]

Run with no arguments in a terminal to enter the interactive REPL. Pipe stdin
or pass --execute to run a single turn and exit.

Options:
      --execute, -x [prompt]   Run one agent turn, print the final answer, and exit
      --stream-json            Emit Claude-compatible JSONL in execute mode
      --stream-json-thinking   Include thinking blocks in stream JSON output
      --stream-json-input      Read user messages as JSONL from stdin
      --dangerously-allow-all  Allow tool calls that would otherwise require approval
      --mcp-config <json>      Add an inline MCP server config for this run
      --mode <name>            Agent mode: smart, deep, rush, or large
      --jetbrains              Connect to a JetBrains IDE
  -h, --help                   Show help
  -v, --version                Show version

Commands:
  login                        Print local login instructions
  update                       Check for updates
  usage                        Show local usage estimates
  review                       Run a local review stub
  tools list|make|show|use     Manage built-in and toolbox tools
  permissions list             Show permission policy rules
  config edit [--workspace]    Open settings in $EDITOR
  mcp add|list|doctor|approve|oauth
                               Manage MCP server settings
  skill add|list|show|remove   Manage Amp agent skills
  plugins list                 Show project and user plugin files
  threads list|show|search|archive|continue|handoff|report
                               Manage local thread records
  agents list                  Show AGENTS.md guidance files used for this cwd
`);
}
