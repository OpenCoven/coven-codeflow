import { parseGlobalArgs, UsageError } from './cli/parse.mjs';
import { printHelp } from './cli/help.mjs';
import { runCommand } from './cli/dispatch.mjs';
import { runExecute } from './cli/execute.mjs';
import { runInteractive } from './cli/repl.mjs';
import { runTuiInteractive } from './cli/tui.mjs';
import { runIdeConnect } from './commands/ide.mjs';
import { readStdin } from './util/shell.mjs';
import { AGENT_MODES, VERSION } from './constants.mjs';
import { latestActiveThread, requireThread } from './threads/store.mjs';
import { reasoningEffortForMode } from './cli/reasoning.mjs';

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

  if (parsed.ide) {
    runIdeConnect(parsed.ide);
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
  if (parsed.continueThread && !parsed.execute) {
    throw new UsageError('--continue requires --execute');
  }
  if (!AGENT_MODES.includes(parsed.mode)) {
    throw new UsageError(`mode must be one of: ${AGENT_MODES.join(', ')}`);
  }
  parsed.reasoningEffort = reasoningEffortForMode(parsed.mode, parsed.reasoningEffort);

  if (parsed.execute || (stdin.length > 0 && !process.stdout.isTTY)) {
    await runExecute(parsed, stdin, { thread: continuationThread(parsed) });
    return;
  }

  if (process.stdout.isTTY && (process.stdin.isTTY || stdin.length > 0)) {
    const runner = selectInteractiveRunner({
      stdinIsTTY: Boolean(process.stdin.isTTY),
      stdoutIsTTY: Boolean(process.stdout.isTTY),
      env: process.env,
    });
    if (runner === 'tui') await runTuiInteractive(parsed, stdin);
    else await runInteractive(parsed, stdin);
    return;
  }

  printHelp();
}

export function selectInteractiveRunner({ stdinIsTTY, stdoutIsTTY, env }) {
  if (env.COVEN_CODE_REPL === '1') return 'repl';
  if (stdinIsTTY && stdoutIsTTY) return 'tui';
  return 'repl';
}

function continuationThread(parsed) {
  if (!parsed.continueThread) return undefined;
  if (typeof parsed.continueThread === 'string') return requireThread(parsed.continueThread);
  const thread = latestActiveThread();
  if (!thread) throw new UsageError('No active thread to continue');
  return thread;
}
