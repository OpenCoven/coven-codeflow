import { CLI_NAME, PRODUCT_NAME } from '../constants.mjs';

export function printHelp() {
  console.log(`${PRODUCT_NAME}

Usage: ${CLI_NAME} [options] [command]

Run with no arguments in a terminal to enter the interactive REPL. Piped stdin
becomes the first interactive message when stdout is a TTY. Pass --execute or
redirect stdout to run a single turn and exit.

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
`);
}
