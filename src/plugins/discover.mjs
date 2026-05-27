import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configDir, findProjectRoot } from '../settings/paths.mjs';
import {
  createPluginApi,
  createPluginCommandContext,
  createPluginContext,
  createPluginToolContext,
} from './api.mjs';

export { createPluginCommandContext, createPluginToolContext };

export function discoverPluginFiles(cwd) {
  const projectRoot = findProjectRoot(cwd);
  return [
    ...readPluginDir(path.join(projectRoot, '.coven-code', 'plugins'), 'project'),
    ...readPluginDir(path.join(configDir(), 'coven-code', 'plugins'), 'user'),
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
  const runtime = {
    tools: [],
    commands: [],
    handlers: {},
    configurationSubscribers: [],
    notifications: [],
    statusItems: [],
    pluginSummaries: [],
    currentPlugin: undefined,
  };
  const seen = new Set();
  const api = createPluginApi({ cwd, runtime });
  for (const plugin of discoverPluginFiles(cwd)) {
    const module = await import(pathToFileURL(plugin.path).href);
    const summary = {
      name: plugin.name,
      source: plugin.source,
      path: plugin.path,
      tools: [],
      commands: [],
      events: [],
    };
    runtime.currentPlugin = summary;
    if (typeof module.default === 'function') await module.default(api);
    runtime.pluginSummaries.push(summary);
    runtime.currentPlugin = undefined;
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

export async function runPluginEventHandlers(handlers = [], event = {}, validateResult = () => {}) {
  let decision;
  for (const handler of handlers) {
    const result = await handler(event, createPluginContext(event));
    if (result) validateResult(result);
    if (!result || result.action === 'allow') continue;
    decision ??= result;
  }
  return decision ?? { action: 'allow' };
}
