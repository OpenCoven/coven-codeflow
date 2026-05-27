import { readFileSync } from 'node:fs';
import { BUILTIN_TOOLS, CLI_NAME } from '../constants.mjs';
import { listSkills } from '../skills/discover.mjs';
import { loadPlugins } from '../plugins/discover.mjs';

const STATIC_COMMANDS = [
  {
    name: 'help',
    command: '/help',
    title: 'Help',
    category: 'session',
    source: 'built-in',
    usage: '/help',
    description: 'Show slash commands and keybindings',
  },
  {
    name: 'mode',
    command: '/mode',
    title: 'Mode',
    category: 'session',
    source: 'built-in',
    usage: '/mode [name]',
    description: 'show or set mode: smart, deep, rush, large',
  },
  {
    name: 'reasoning',
    command: '/reasoning',
    title: 'Reasoning effort',
    category: 'session',
    source: 'built-in',
    usage: '/reasoning [level|next]',
    description: 'Show, set, or cycle reasoning effort',
  },
  {
    name: 'new',
    command: '/new',
    title: 'New thread',
    category: 'thread',
    source: 'built-in',
    usage: '/new',
    description: 'Start a fresh thread',
  },
  {
    name: 'continue',
    command: '/continue',
    title: 'Continue thread',
    category: 'thread',
    source: 'built-in',
    usage: '/continue [thread-id]',
    description: 'Continue the latest active thread or a specific thread',
  },
  {
    name: 'queue',
    command: '/queue',
    title: 'Queue prompt',
    category: 'thread',
    source: 'built-in',
    usage: '/queue <prompt>',
    description: 'Send a follow-up prompt after the next turn',
  },
  {
    name: 'lane',
    command: '/lane',
    title: 'Lane panel',
    category: 'lane',
    source: 'built-in',
    usage: '/lane refresh | /lane verify | /lane status | /lane diff | /lane harness <name|next>',
    description: 'TUI lane actions for worktree, harness, diff, and verification state',
  },
  {
    name: 'editor',
    command: '/editor',
    title: 'Open editor',
    category: 'composer',
    source: 'built-in',
    usage: '/editor',
    aliases: ['Ctrl+G'],
    description: 'compose the next prompt in $EDITOR',
  },
  {
    name: 'edit',
    command: '/edit',
    title: 'Edit previous prompt',
    category: 'composer',
    source: 'built-in',
    usage: '/edit',
    description: 'Edit the previous prompt in $EDITOR',
  },
  {
    name: 'exit',
    command: '/exit',
    title: 'Exit',
    category: 'session',
    source: 'built-in',
    usage: '/exit',
    aliases: ['/quit'],
    description: 'Leave the interactive session',
  },
  {
    name: `${CLI_NAME}:`,
    command: `/${CLI_NAME}: help`,
    title: 'Command palette help',
    category: 'session',
    source: 'built-in',
    usage: `/${CLI_NAME}: help`,
    description: 'Show command-palette help',
  },
  {
    name: 'thread:',
    command: '/thread:',
    title: 'Thread actions',
    category: 'thread',
    source: 'built-in',
    usage: '/thread: archive and quit | /thread: set visibility <level>',
    description: 'Archive or update the current thread',
  },
  {
    name: 'feedback:',
    command: '/feedback:',
    title: 'Feedback report',
    category: 'diagnostics',
    source: 'built-in',
    usage: '/feedback: send report with diagnostics',
    description: 'Create a diagnostic report for the current thread',
  },
];

const TOP_LEVEL_COMMANDS = [
  ['tools', 'Tools', 'Inspect and manage built-in and toolbox tools', '/tools [list|show|make|use]'],
  ['skill:', 'Skills', 'List or inspect installed skills', '/skill: list | /skill: show <name>'],
  ['plugins:', 'Plugins', 'List, reload, or inspect plugin commands', '/plugins: list | /plugins: reload | /plugins: commands'],
  ['threads', 'Threads', 'List, show, search, archive, or map local threads', '/threads [list|show|search|archive|visibility|map|report]'],
  ['permissions', 'Permissions', 'Inspect or test permission policy rules', '/permissions list'],
  ['config', 'Config', 'Open user or workspace settings', '/config edit [--workspace]'],
  ['mcp', 'MCP', 'Manage MCP server settings', '/mcp [add|list|doctor|approve|oauth]'],
  ['ide', 'IDE', 'Connect or inspect local IDE integration', '/ide connect'],
  ['agents', 'Agents guidance', 'Show AGENTS.md guidance files used for this cwd', '/agents list'],
  ['review', 'Review', 'Run configured local review checks', '/review'],
  ['usage', 'Usage', 'Show local usage estimates', '/usage'],
  ['login', 'Login', 'Print local login instructions', '/login'],
  ['update', 'Update', 'Check for updates', '/update'],
];

export function buildStaticSlashCommandCatalog() {
  return normalizeCatalog([
    ...STATIC_COMMANDS,
    ...TOP_LEVEL_COMMANDS.map(([name, title, description, usage]) => ({
      name,
      command: `/${name}`,
      title,
      category: 'command',
      source: 'top-level',
      usage,
      description,
    })),
  ]);
}

export async function buildSlashCommandCatalog(options = {}) {
  const restoreEnv = applyTemporaryEnv(options.env);
  try {
    const parsed = options.parsed ?? {};
    const cwd = options.cwd ?? process.cwd();
    const entries = [
      ...buildStaticSlashCommandCatalog(),
      ...safeSkillSlashCommands(parsed, cwd),
      ...await safePluginSlashCommands(cwd),
    ];
    return normalizeCatalog(entries);
  } finally {
    restoreEnv();
  }
}

export function filterSlashCommands(catalog = [], input = '') {
  const query = slashQuery(input);
  const entries = query
    ? catalog.filter((entry) => slashSearchText(entry).includes(query))
    : catalog;
  return entries
    .map((entry, index) => ({ entry, score: slashScore(entry, query, index) }))
    .sort((a, b) => a.score - b.score)
    .map(({ entry }) => entry);
}

export function formatSlashCommandDetails(entry) {
  if (!entry) return ['No command selected.'];
  const lines = [
    `${entry.command}  ${entry.title}`,
    `Category: ${entry.category}`,
    `Source: ${entry.source}`,
    `Usage: ${entry.usage ?? entry.command}`,
    `Status: ${formatAvailability(entry.availability)}`,
  ];
  if (entry.aliases?.length) lines.push(`Aliases: ${entry.aliases.join(', ')}`);
  if (entry.filePath) lines.push(`File: ${entry.filePath}`);
  if (entry.description) lines.push('', entry.description);
  return lines;
}

export function formatSlashHelpLines(catalog = buildStaticSlashCommandCatalog()) {
  const visible = catalog.filter((entry) => entry.availability?.type !== 'hidden');
  const commandLines = visible.map((entry) => {
    const usage = entry.usage ?? entry.command;
    const status = entry.availability?.type === 'disabled' ? ` (${entry.availability.reason})` : '';
    return `  ${usage.padEnd(28)} ${entry.description}${status}`;
  });
  return [
    'Slash commands:',
    ...commandLines,
    'End a line with `\\` to continue the prompt onto the next line.',
    'Anything else is sent as a one-turn prompt.',
    '',
    'Keybindings:',
    '  /                     open slash commands',
    '  Tab                   complete the selected slash command',
    '  Up/Down               move through slash commands or previous messages',
    '  Esc                   close overlays',
    '  Ctrl+P                open the command palette',
    '  Ctrl+N                start a fresh thread',
    '  Ctrl+M                switch agent modes',
    '  Ctrl+R                search prompt history',
    '  Ctrl+G                open the current prompt in $EDITOR',
    '  Alt+D                 cycle reasoning effort for the active mode',
    '  @                     mention files',
  ];
}

export function findSlashCommand(catalog = [], name) {
  const normalized = slashQuery(name);
  return catalog.find((entry) => slashQuery(entry.name) === normalized);
}

function skillSlashCommands(parsed, cwd) {
  return listSkills({ parsed, cwd }).map((skill) => ({
    name: skill.name,
    command: `/${skill.name}`,
    title: skill.name,
    category: 'skill',
    source: 'skill',
    usage: `/${skill.name} [prompt]`,
    description: skill.description || 'Skill command',
    filePath: skill.filePath,
    skill,
  }));
}

async function pluginSlashCommands(cwd) {
  const runtime = await loadPlugins(cwd);
  return runtime.commands
    .filter((command) => command.availability.type !== 'hidden')
    .map((command) => ({
      name: command.name,
      command: `/${command.name}`,
      title: command.metadata.title ?? command.name,
      category: command.metadata.category ?? 'plugin',
      source: 'plugin',
      usage: `/${command.name}`,
      description: command.metadata.description ?? command.metadata.title ?? command.name,
      availability: command.availability,
      pluginCommand: command,
    }));
}

function safeSkillSlashCommands(parsed, cwd) {
  try {
    return skillSlashCommands(parsed, cwd);
  } catch (error) {
    console.error(`${CLI_NAME}: skill catalog unavailable: ${error?.message ?? error}`);
    return [];
  }
}

async function safePluginSlashCommands(cwd) {
  try {
    return await pluginSlashCommands(cwd);
  } catch (error) {
    console.error(`${CLI_NAME}: plugin catalog unavailable: ${error?.message ?? error}`);
    return [];
  }
}

function normalizeCatalog(entries) {
  const seen = new Set();
  const catalog = [];
  for (const entry of entries) {
    const normalized = {
      availability: { type: 'enabled' },
      aliases: [],
      ...entry,
    };
    const key = slashQuery(normalized.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    catalog.push(normalized);
  }
  return catalog;
}

function slashQuery(input = '') {
  return String(input)
    .trim()
    .replace(/^\/+/, '')
    .toLowerCase();
}

function slashSearchText(entry) {
  return [
    entry.name,
    entry.command,
    entry.title,
    entry.category,
    entry.source,
    entry.description,
    ...(entry.aliases ?? []),
  ].join(' ').toLowerCase();
}

function slashScore(entry, query, index) {
  if (!query) return index;
  const name = slashQuery(entry.name);
  if (name === query) return index - 10_000;
  if (name.startsWith(query)) return index - 1_000;
  if (slashQuery(entry.command).startsWith(query)) return index - 500;
  return index;
}

function formatAvailability(availability = { type: 'enabled' }) {
  if (availability.type === 'disabled') return `disabled - ${availability.reason}`;
  return availability.type ?? 'enabled';
}

function applyTemporaryEnv(env) {
  if (!env) return () => {};
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export function skillPromptFromSlashCommand(entry, prompt) {
  const skillText = entry?.filePath ? readSkillText(entry.filePath) : '';
  return [
    `[skill:${entry.name}]`,
    skillText.trim(),
    '[/skill]',
    '',
    '[prompt]',
    prompt.trim(),
    '[/prompt]',
  ].join('\n');
}

function readSkillText(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

export function builtinToolSummaryLines(limit = 12) {
  return [
    `Built-in tools: ${BUILTIN_TOOLS.length}`,
    ...BUILTIN_TOOLS.slice(0, limit).map(([name, kind, description]) => `${name} (${kind}) - ${description}`),
  ];
}
