import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configDir, findProjectRoot } from '../settings/paths.mjs';
import { shellQuote } from '../util/shell.mjs';

export function discoverPluginFiles(cwd) {
  return [
    ...readPluginDir(path.join(findProjectRoot(cwd), '.amp', 'plugins'), 'project'),
    ...readPluginDir(path.join(configDir(), 'amp', 'plugins'), 'user'),
  ];
}

function readPluginDir(dir, source) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.ts'))
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => ({
      name: path.basename(entry, '.ts'),
      source,
      path: path.join(dir, entry),
    }));
}

export async function loadPlugins(cwd) {
  const runtime = { tools: [], commands: [], handlers: {} };
  const seen = new Set();
  const api = createPluginApi({ cwd, runtime });
  for (const plugin of discoverPluginFiles(cwd)) {
    const module = await import(pathToFileURL(plugin.path).href);
    if (typeof module.default === 'function') await module.default(api);
  }
  runtime.tools = runtime.tools.filter((tool) => {
    if (!tool?.name || seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
  runtime.commands = runtime.commands.filter((command) => command?.name);
  return runtime;
}

export async function listPluginTools(cwd) {
  return (await loadPlugins(cwd)).tools;
}

export async function runPluginEventHandlers(handlers = [], event = {}) {
  for (const handler of handlers) {
    const result = await handler(event, createPluginContext());
    if (!result || result.action === 'allow') continue;
    return result;
  }
  return { action: 'allow' };
}

export function createPluginCommandContext() {
  const notifications = [];
  return {
    notifications,
    ui: {
      notify(message) {
        notifications.push(String(message));
      },
      confirm: async () => false,
      input: async () => undefined,
      select: async () => undefined,
    },
    system: {
      open: async (target) => {
        notifications.push(String(target));
      },
    },
  };
}

function createPluginApi({ cwd, runtime }) {
  return {
    registerTool(tool) {
      runtime.tools.push({ ...tool, description: tool.description ?? '' });
      return { dispose() {} };
    },
    registerCommand(name, metadata = {}, handler = async () => undefined) {
      const command = {
        name,
        metadata,
        handler,
        availability: metadata.availability ?? { type: 'enabled' },
      };
      runtime.commands.push(command);
      return {
        setAvailability(availability) {
          command.availability = availability;
        },
        dispose() {
          runtime.commands = runtime.commands.filter((entry) => entry !== command);
        },
      };
    },
    on(eventName, handler) {
      if (!runtime.handlers[eventName]) runtime.handlers[eventName] = [];
      runtime.handlers[eventName].push(handler);
      return {
        dispose() {
          runtime.handlers[eventName] = (runtime.handlers[eventName] ?? []).filter((entry) => entry !== handler);
        },
      };
    },
    logger: { log() {}, warn() {}, error() {} },
    $: (strings, ...values) => runPluginShell(cwd, strings, values),
  };
}

function createPluginContext() {
  return {
    ui: {
      notify() {},
      confirm: async () => false,
      input: async () => undefined,
      select: async () => undefined,
    },
    ai: {
      ask: async () => ({ result: 'no', reason: 'local recreation' }),
    },
  };
}

function runPluginShell(cwd, strings, values) {
  const command = strings.reduce((text, part, index) => {
    return `${text}${part}${index < values.length ? shellQuote(values[index]) : ''}`;
  }, '');
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8' });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 0,
  };
}
