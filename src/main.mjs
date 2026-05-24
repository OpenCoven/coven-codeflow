import { parseGlobalArgs, UsageError } from './cli/parse.mjs';
import { printHelp } from './cli/help.mjs';
import { runCommand } from './cli/dispatch.mjs';
import { runExecute } from './cli/execute.mjs';
import { runInteractive } from './cli/repl.mjs';
import { readStdin } from './util/shell.mjs';
import { VERSION } from './constants.mjs';

export { UsageError };

export async function main() {
  const args = process.argv.slice(2);
  const parsed = parseGlobalArgs(args);
  const stdin = readStdin();

  if (parsed.help) {
    printHelp();
    return;
  }

  if (parsed.version) {
    console.log(VERSION);
    return;
  }

  const command = parsed.positionals[0];
  if (command) {
    await runCommand(command, parsed.positionals.slice(1), parsed, stdin);
    return;
  }

  if (parsed.streamJson && !parsed.execute) {
    throw new UsageError('--stream-json requires --execute');
  }
  if (parsed.streamJsonInput && !parsed.streamJson) {
    throw new UsageError('--stream-json-input requires --stream-json');
  }

  if (parsed.execute || stdin.length > 0) {
    await runExecute(parsed, stdin);
    return;
  }

  if (process.stdout.isTTY && process.stdin.isTTY) {
    await runInteractive(parsed);
    return;
  }

  printHelp();
}
