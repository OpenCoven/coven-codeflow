import * as readline from 'node:readline/promises';
import { CLI_NAME, REPL_HISTORY_LIMIT, VERSION } from '../constants.mjs';
import {
  appendReplHistory,
  createInteractiveSession,
  handleInteractiveInput,
  loadReplHistory,
} from './interactive-core.mjs';

export async function runInteractive(parsed, initialInput = '') {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: REPL_HISTORY_LIMIT,
    removeHistoryDuplicates: true,
    history: loadReplHistory(),
  });
  const session = createInteractiveSession(parsed);
  let buffer = [];
  console.log(`${CLI_NAME} ${VERSION} — interactive mode. Type /exit or press Ctrl-D to quit, /help for slash commands.`);
  if (initialInput.trim()) {
    await handleInteractiveInput(session, initialInput.trim());
    if (!process.stdin.isTTY) {
      rl.close();
      return;
    }
  }
  rl.setPrompt('> ');
  rl.prompt();
  try {
    for await (const line of rl) {
      if (line.trim()) await appendReplHistory(line);
      if (line.endsWith('\\')) {
        buffer.push(line.slice(0, -1));
        rl.setPrompt('… ');
        rl.prompt();
        continue;
      }
      buffer.push(line);
      const text = buffer.join('\n').trim();
      buffer = [];
      rl.setPrompt('> ');
      if (!text) {
        rl.prompt();
        continue;
      }
      const result = await handleInteractiveInput(session, text);
      if (result.lines.length > 0) {
        for (const outputLine of result.lines) {
          if (result.kind === 'error') console.error(outputLine);
          else console.log(outputLine);
        }
      }
      if (result.kind === 'exit') break;
      rl.prompt();
    }
  } finally {
    rl.close();
  }
}
