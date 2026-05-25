import {
  createPluginCommandContext,
  loadPlugins,
} from '../plugins/discover.mjs';
import { UsageError } from '../cli/parse.mjs';
import { printRows } from '../util/table.mjs';

export async function runPlugins(args) {
  const subcommand = args[0] ?? 'list';

  if (subcommand === 'list') {
    const runtime = await loadPlugins(process.cwd());
    if (runtime.pluginSummaries.length === 0) {
      console.log('No plugins found.');
      return;
    }
    for (const plugin of runtime.pluginSummaries) {
      console.log(formatPluginSummary(plugin));
    }
    return;
  }

  if (subcommand === 'reload') {
    const runtime = await loadPlugins(process.cwd());
    console.log(`Reloaded ${runtime.pluginSummaries.length} plugin(s).`);
    for (const plugin of runtime.pluginSummaries) {
      console.log(formatPluginSummary(plugin));
    }
    return;
  }

  if (subcommand === 'commands') {
    const commands = (await loadPlugins(process.cwd())).commands;
    if (commands.length === 0) {
      console.log('No plugin commands found.');
      return;
    }
    printRows(commands
      .filter((command) => command.availability.type !== 'hidden')
      .map((command) => [
        command.name,
        command.availability.type,
        command.metadata.category ?? '',
        command.metadata.title ?? command.name,
        command.availability.type === 'disabled'
          ? command.availability.reason ?? command.metadata.description ?? ''
          : command.metadata.description ?? '',
      ]));
    return;
  }

  if (subcommand === 'run') {
    const commandName = args[1];
    if (!commandName) throw new UsageError('plugins run requires a command name');
    const plugins = await loadPlugins(process.cwd());
    const command = plugins.commands.find((entry) => entry.name === commandName);
    if (!command) throw new UsageError(`Unknown plugin command: ${commandName}`);
    if (command.availability.type === 'hidden') throw new UsageError(`Unknown plugin command: ${commandName}`);
    if (command.availability.type === 'disabled') {
      throw new UsageError(command.availability.reason ?? `Plugin command disabled: ${commandName}`);
    }
    const ctx = createPluginCommandContext(process.cwd());
    const result = await command.handler(ctx);
    if (result !== undefined) console.log(String(result));
    for (const message of plugins.notifications) console.log(message);
    for (const message of ctx.notifications) console.log(message);
    return;
  }

  throw new UsageError(`Unknown plugins command: ${subcommand}`);
}

function formatPluginSummary(plugin) {
  return [
    plugin.name,
    plugin.source,
    `tools=${formatRegistrations(plugin.tools)}`,
    `commands=${formatRegistrations(plugin.commands)}`,
    `events=${formatRegistrations(plugin.events)}`,
    plugin.path,
  ].join('\t');
}

function formatRegistrations(values = []) {
  return values.length > 0 ? values.join(',') : '-';
}
