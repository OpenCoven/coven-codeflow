import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { AGENT_MODES, CLI_NAME, CONFIG_SUBDIR, REPL_HISTORY_LIMIT, VERSION } from '../constants.mjs';
import { configDir } from '../settings/paths.mjs';
import { shellQuote, splitShellWords } from '../util/shell.mjs';
import { latestActiveThread, requireThread } from '../threads/store.mjs';
import { runCommand } from './dispatch.mjs';
import { runExecute } from './execute.mjs';
import {
  coerceReasoningEffortForMode,
  nextReasoningEffortForMode,
  reasoningEffortForMode,
} from './reasoning.mjs';

export async function runInteractive(parsed, initialInput = '') {
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
  const queuedMessages = [];
  console.log(`${CLI_NAME} ${VERSION} — interactive mode. Type /exit or press Ctrl-D to quit, /help for slash commands.`);
  if (initialInput.trim()) {
    thread = await runInteractiveTurn(parsed, initialInput.trim(), thread);
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
      if (text === '/exit' || text === '/quit') break;
      if (text === '/help') {
        printSlashHelp();
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
            parsed.reasoningEffort = coerceReasoningEffortForMode(parsed.mode, parsed.reasoningEffort);
            console.log(`mode: ${parsed.mode}`);
            console.log(`reasoning effort: ${parsed.reasoningEffort}`);
          } else {
            console.error(`${CLI_NAME}: Unknown mode: ${nextMode}`);
          }
          rl.prompt();
          continue;
        }
        if (cmd === 'reasoning') {
          try {
            const nextEffort = rest[0] === 'next'
              ? nextReasoningEffortForMode(parsed.mode, parsed.reasoningEffort)
              : rest[0];
            parsed.reasoningEffort = reasoningEffortForMode(parsed.mode, nextEffort ?? parsed.reasoningEffort);
            console.log(`reasoning effort: ${parsed.reasoningEffort}`);
          } catch (error) {
            console.error(`${CLI_NAME}: ${error?.message ?? error}`);
          }
          rl.prompt();
          continue;
        }
        if (cmd === 'queue') {
          const queued = rest.join(' ').trim();
          if (!queued) console.error(`${CLI_NAME}: /queue requires a prompt`);
          else {
            queuedMessages.push(queued);
            console.log(`queued: ${queued}`);
          }
          rl.prompt();
          continue;
        }
        if (cmd === 'new') {
          thread = undefined;
          console.log('new thread');
          rl.prompt();
          continue;
        }
        if (cmd === 'continue') {
          try {
            thread = interactiveContinuationThread(rest[0]);
            console.log(`continued: ${thread.id}`);
          } catch (error) {
            console.error(`${CLI_NAME}: ${error?.message ?? error}`);
          }
          rl.prompt();
          continue;
        }
        if (cmd === `${CLI_NAME}:` && rest.join(' ') === 'help') {
          printSlashHelp();
          rl.prompt();
          continue;
        }
        if (cmd === 'skill:') {
          try {
            await runCommand('skill', rest, parsed, '');
          } catch (error) {
            console.error(`${CLI_NAME}: ${error?.message ?? error}`);
          }
          rl.prompt();
          continue;
        }
        if (cmd === 'plugins:') {
          try {
            await runCommand('plugins', rest, parsed, '');
          } catch (error) {
            console.error(`${CLI_NAME}: ${error?.message ?? error}`);
          }
          rl.prompt();
          continue;
        }
        if (cmd === 'editor') {
          const edited = await readEditorPrompt();
          if (edited) {
            thread = await runInteractiveTurn(parsed, edited, thread);
            while (queuedMessages.length > 0) {
              thread = await runInteractiveTurn(parsed, queuedMessages.shift(), thread);
            }
          }
          rl.prompt();
          continue;
        }
        if (cmd === 'edit') {
          try {
            if (!thread) throw new Error('No current thread to edit');
            const editTarget = editablePreviousPrompt(thread);
            const edited = await readEditorPrompt(editTarget.prompt);
            if (edited) {
              thread.messages = thread.messages.slice(0, editTarget.index);
              if (thread.messages.length === 0) {
                thread.title = edited.split(/\r?\n/).find(Boolean)?.slice(0, 120) || '(empty prompt)';
              }
              thread = await runInteractiveTurn(parsed, edited, thread);
              while (queuedMessages.length > 0) {
                thread = await runInteractiveTurn(parsed, queuedMessages.shift(), thread);
              }
            }
          } catch (error) {
            console.error(`${CLI_NAME}: ${error?.message ?? error}`);
          }
          rl.prompt();
          continue;
        }
        if (cmd === 'thread:' && rest.join(' ') === 'archive and quit') {
          try {
            if (!thread) throw new Error('No current thread to archive');
            await runCommand('threads', ['archive', thread.id], parsed, '');
            break;
          } catch (error) {
            console.error(`${CLI_NAME}: ${error?.message ?? error}`);
            rl.prompt();
            continue;
          }
        }
        if (cmd === 'thread:' && rest[0] === 'set' && rest[1] === 'visibility') {
          try {
            if (!thread) throw new Error('No current thread to update');
            await runCommand('threads', ['visibility', thread.id, ...rest.slice(2)], parsed, '');
          } catch (error) {
            console.error(`${CLI_NAME}: ${error?.message ?? error}`);
          }
          rl.prompt();
          continue;
        }
        if (cmd === 'feedback:' && rest.join(' ') === 'send report with diagnostics') {
          try {
            if (!thread) throw new Error('No current thread to report');
            await runCommand('threads', ['report', thread.id], parsed, '');
          } catch (error) {
            console.error(`${CLI_NAME}: ${error?.message ?? error}`);
          }
          rl.prompt();
          continue;
        }
        try {
          await runCommand(cmd, rest, parsed, '');
        } catch (error) {
          if (!(await runPluginCommandFallback(cmd, error))) {
            console.error(`${CLI_NAME}: ${error?.message ?? error}`);
          }
        }
        rl.prompt();
        continue;
      }
      thread = await runInteractiveTurn(parsed, text, thread);
      while (queuedMessages.length > 0) {
        thread = await runInteractiveTurn(parsed, queuedMessages.shift(), thread);
      }
      rl.prompt();
    }
  } finally {
    rl.close();
  }
}

async function runPluginCommandFallback(cmd, originalError) {
  if (!String(originalError?.message ?? '').startsWith('Unknown command:')) return false;
  try {
    await runCommand('plugins', ['run', cmd], {}, '');
    return true;
  } catch (pluginError) {
    if (String(pluginError?.message ?? '').startsWith('Unknown plugin command:')) return false;
    throw pluginError;
  }
}

function printSlashHelp() {
  console.log('Slash commands:');
  console.log('  /exit, /quit          leave the REPL');
  console.log('  /help                 show this message');
  console.log(`  /${CLI_NAME}: help`);
  console.log('                         show command-palette help');
  console.log('  /mode [name]          show or set mode: smart, deep, rush, large');
  console.log('  /reasoning [level|next]');
  console.log('                         show, set, or cycle reasoning effort');
  console.log('  /new                  start a fresh thread');
  console.log('  /continue [thread-id] continue the latest active thread or a specific thread');
  console.log('  /queue <prompt>       send a follow-up prompt after the next turn');
  console.log('  /editor               compose the next prompt in $EDITOR');
  console.log('  /edit                 edit the previous prompt in $EDITOR');
  console.log('  /ide connect          connect or inspect local IDE integration');
  console.log('  /skill: list          list installed skills');
  console.log('  /plugins: reload      reload project and user plugins');
  console.log('  /thread: archive and quit');
  console.log('                         archive the current thread and leave the REPL');
  console.log('  /thread: set visibility <level>');
  console.log('                         set current thread visibility');
  console.log('  /feedback: send report with diagnostics');
  console.log('                         create a diagnostic report for the current thread');
  console.log(`  /<subcommand> [args]  run any top-level ${CLI_NAME} subcommand (e.g. /tools list)`);
  console.log('End a line with `\\` to continue the prompt onto the next line.');
  console.log('Anything else is sent as a one-turn prompt.');
  console.log('');
  console.log('Keybindings:');
  console.log('  Ctrl+O                open the command palette');
  console.log('  Ctrl+G                open the current prompt in $EDITOR');
  console.log('  Ctrl+S                switch agent modes');
  console.log('  Ctrl+R                search prompt history');
  console.log('  Up/Down               move through previous messages');
  console.log('  Alt+T                 expand thinking and tool blocks');
  console.log('  Alt+D                 cycle reasoning effort for the active mode');
  console.log('  @                     mention files');
}

async function readEditorPrompt(initialText = '') {
  const editor = process.env.EDITOR || process.env.VISUAL;
  if (!editor) {
    console.error(`${CLI_NAME}: /editor requires $EDITOR or $VISUAL`);
    return '';
  }
  const file = path.join(tmpdir(), `${CONFIG_SUBDIR}-prompt-${process.pid}-${Date.now()}.md`);
  try {
    await writeFile(file, initialText);
    const result = spawnSync(`${editor} ${shellQuote(file)}`, {
      stdio: 'inherit',
      shell: true,
    });
    if (result.error) {
      console.error(`${CLI_NAME}: Unable to run editor: ${result.error.message}`);
      return '';
    }
    if ((result.status ?? 0) !== 0) {
      console.error(`${CLI_NAME}: Editor exited with status ${result.status}`);
      return '';
    }
    return (await readFile(file, 'utf8')).trim();
  } finally {
    await unlink(file).catch(() => {});
  }
}

function editablePreviousPrompt(thread) {
  const index = (thread.messages ?? []).findLastIndex((message) => (
    message.role === 'user' && typeof message.content === 'string'
  ));
  if (index === -1) throw new Error('No previous user prompt to edit');
  return { index, prompt: thread.messages[index].content };
}

function interactiveContinuationThread(threadId) {
  if (threadId) return requireThread(threadId);
  const thread = latestActiveThread();
  if (!thread) throw new Error('No active thread to continue');
  return thread;
}

async function runInteractiveTurn(parsed, text, thread) {
  try {
    return await runExecute(
      { ...parsed, execute: true, prompt: text, streamJson: false, streamJsonThinking: false, streamJsonInput: false },
      '',
      { thread },
    );
  } catch (error) {
    console.error(`${CLI_NAME}: ${error?.message ?? error}`);
    return thread;
  }
}

function replHistoryFile() {
  return process.env.COVEN_CODE_REPL_HISTORY_FILE
    || path.join(configDir(), CONFIG_SUBDIR, 'repl_history');
}

function loadReplHistory() {
  if (process.env.COVEN_CODE_REPL_HISTORY === '0') return [];
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
  if (process.env.COVEN_CODE_REPL_HISTORY === '0') return;
  try {
    const file = replHistoryFile();
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${line}\n`);
  } catch {
    // history must never break the REPL
  }
}
