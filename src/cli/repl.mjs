import { readFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { AGENT_MODES, REPL_HISTORY_LIMIT, VERSION } from '../constants.mjs';
import { configDir } from '../settings/paths.mjs';
import { splitShellWords } from '../util/shell.mjs';
import { runCommand } from './dispatch.mjs';
import { runExecute } from './execute.mjs';

export async function runInteractive(parsed) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: REPL_HISTORY_LIMIT,
    removeHistoryDuplicates: true,
    history: loadReplHistory(),
  });
  let thread;
  let buffer = [];
  console.log(`amp ${VERSION} — interactive mode. Type /exit or press Ctrl-D to quit, /help for slash commands.`);
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
      if (text === '/exit' || text === '/quit') break;
      if (text === '/help') {
        console.log('Slash commands:');
        console.log('  /exit, /quit          leave the REPL');
        console.log('  /help                 show this message');
        console.log('  /mode [name]          show or set mode: smart, deep, rush, large');
        console.log('  /<subcommand> [args]  run any top-level amp subcommand (e.g. /tools list)');
        console.log('End a line with `\\` to continue the prompt onto the next line.');
        console.log('Anything else is sent as a one-turn prompt.');
        rl.prompt();
        continue;
      }
      if (text.startsWith('/')) {
        const tokens = splitShellWords(text.slice(1));
        const [cmd, ...rest] = tokens;
        if (!cmd) {
          rl.prompt();
          continue;
        }
        if (cmd === 'mode') {
          const nextMode = rest[0];
          if (!nextMode) {
            console.log(`mode: ${parsed.mode}`);
          } else if (AGENT_MODES.includes(nextMode)) {
            parsed.mode = nextMode;
            console.log(`mode: ${parsed.mode}`);
          } else {
            console.error(`amp: Unknown mode: ${nextMode}`);
          }
          rl.prompt();
          continue;
        }
        try {
          await runCommand(cmd, rest, parsed, '');
        } catch (error) {
          console.error(`amp: ${error?.message ?? error}`);
        }
        rl.prompt();
        continue;
      }
      try {
        thread = await runExecute(
          { ...parsed, execute: true, prompt: text, streamJson: false, streamJsonThinking: false, streamJsonInput: false },
          '',
          { thread },
        );
      } catch (error) {
        console.error(`amp: ${error?.message ?? error}`);
      }
      rl.prompt();
    }
  } finally {
    rl.close();
  }
}

function replHistoryFile() {
  return process.env.AMP_REPL_HISTORY_FILE || path.join(configDir(), 'amp', 'repl_history');
}

function loadReplHistory() {
  if (process.env.AMP_REPL_HISTORY === '0') return [];
  try {
    return readFileSync(replHistoryFile(), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-REPL_HISTORY_LIMIT)
      .reverse();
  } catch {
    return [];
  }
}

async function appendReplHistory(line) {
  if (process.env.AMP_REPL_HISTORY === '0') return;
  try {
    const file = replHistoryFile();
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${line}\n`);
  } catch {
    // history must never break the REPL
  }
}
