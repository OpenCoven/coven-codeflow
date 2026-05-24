export const VERSION = '0.0.0-recreate';

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
  ['oracle', 'built-in', 'Asks a second-opinion model for review or reasoning'],
  ['Task', 'built-in', 'Runs an isolated subagent for delegated work'],
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
