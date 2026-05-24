import {
  createPluginCommandContext,
  discoverPluginFiles,
  loadPlugins,
} from '../plugins/discover.mjs';
import { UsageError } from '../cli/parse.mjs';
import { printRows } from '../util/table.mjs';

export async function runPlugins(args) {
  const subcommand = args[0] ?? 'list';

  if (subcommand === 'list') {
    const plugins = discoverPluginFiles(process.cwd());
    if (plugins.length === 0) {
      console.log('No plugins found.');
      return;
    }
    for (const plugin of plugins) {
      console.log(`${plugin.name}\t${plugin.source}\t${plugin.path}`);
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
    const command = (await loadPlugins(process.cwd())).commands.find((entry) => entry.name === commandName);
    if (!command) throw new UsageError(`Unknown plugin command: ${commandName}`);
    if (command.availability.type === 'hidden') throw new UsageError(`Unknown plugin command: ${commandName}`);
    if (command.availability.type === 'disabled') {
      throw new UsageError(command.availability.reason ?? `Plugin command disabled: ${commandName}`);
    }
    const ctx = createPluginCommandContext();
    const result = await command.handler(ctx);
    if (result !== undefined) console.log(String(result));
    for (const message of ctx.notifications) console.log(message);
    return;
  }

  throw new UsageError(`Unknown plugins command: ${subcommand}`);
}
