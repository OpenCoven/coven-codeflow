export const VERSION = '0.0.0-recreate';
export const PRODUCT_NAME = 'Coven Code';
export const CLI_NAME = 'coven-code';
export const PACKAGE_NAME = '@opencoven/coven-code';
export const CONFIG_SUBDIR = 'coven-code';
export const PROJECT_SUBDIR = '.coven-code';
export const THREAD_URL_BASE = 'https://coven-code.local/threads';

export const FILE_MENTION_MAX_LINES = 500;
export const FILE_MENTION_MAX_LINE_LENGTH = 2048;
export const REPL_HISTORY_LIMIT = 500;

export const AGENT_MODES = ['smart', 'deep', 'rush', 'large'];

export const BUILTIN_TOOLS = [
  ['Bash', 'built-in', "Executes the given shell command in the user's default shell"],
  ['Read', 'built-in', 'Reads a UTF-8 text file from disk'],
  ['Grep', 'built-in', 'Searches files by regular expression'],
  ['glob', 'built-in', 'Finds files by glob pattern'],
  ['create_file', 'built-in', 'Creates a new file'],
  ['edit_file', 'built-in', 'Edits an existing file'],
  ['oracle', 'built-in', 'Asks for second-opinion review or reasoning'],
  ['librarian', 'built-in', 'Researches code across repositories or the current workspace'],
  ['Task', 'built-in', 'Runs an isolated subagent for delegated work'],
  ['painter', 'built-in', 'Generates or edits local image artifacts'],
  ['mermaid', 'built-in', 'Renders a Mermaid diagram from the provided code'],
  ['look_at', 'built-in', 'Inspects images, PDFs, or media files with a goal'],
  ['web_search', 'built-in', 'Searches the web for information'],
  ['read_web_page', 'built-in', 'Reads and extracts text from a web page'],
  ['undo_edit', 'built-in', 'Undoes the latest edit_file change'],
  ['find_thread', 'built-in', 'Finds prior threads by keyword, file, or task context'],
  ['finder', 'built-in', 'Finds prior threads by keyword, file, or task context'],
  ['read_mcp_resource', 'built-in', 'Reads a resource from a configured MCP server'],
];

export const BUILTIN_PERMISSIONS = [
  ['allow', 'Bash', 'ls'],
  ['allow', 'Bash', 'git status'],
  ['allow', 'Bash', 'git diff'],
  ['allow', 'Bash', 'git log'],
  ['allow', 'Bash', 'npm test'],
  ['allow', 'Bash', 'cargo build'],
  ['ask', 'Bash', 'git push'],
  ['ask', 'Bash', 'rm -rf'],
  ['ask', 'Bash', 'sudo'],
];
