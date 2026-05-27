import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CLI_NAME, CONFIG_SUBDIR, REPL_HISTORY_LIMIT } from '../constants.mjs';
import { configDir } from '../settings/paths.mjs';
import { shellQuote } from '../util/shell.mjs';
import { latestActiveThread, requireThread } from '../threads/store.mjs';
import { runExecute } from './execute.mjs';

export async function runInteractiveTurn(parsed, text, thread, executeRunner = runExecute, options = {}) {
  try {
    return await executeRunner(
      { ...parsed, execute: true, prompt: text, streamJson: false, streamJsonThinking: false, streamJsonInput: false },
      '',
      { thread, ...options },
    );
  } catch (error) {
    console.error(`${CLI_NAME}: ${error?.message ?? error}`);
    return thread;
  }
}

export async function submitPromptAndQueue(session, text) {
  session.thread = await runInteractiveTurn(session.parsed, text, session.thread, session.executeRunner, { silent: session.silent });
  while (session.queuedMessages.length > 0) {
    session.thread = await runInteractiveTurn(session.parsed, session.queuedMessages.shift(), session.thread, session.executeRunner, { silent: session.silent });
  }
}

export async function readEditorPrompt(initialText = '') {
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

export function editablePreviousPrompt(thread) {
  const index = (thread.messages ?? []).findLastIndex((message) => (
    message.role === 'user' && typeof message.content === 'string'
  ));
  if (index === -1) throw new Error('No previous user prompt to edit');
  return { index, prompt: thread.messages[index].content };
}

export function interactiveContinuationThread(threadId) {
  if (threadId) return requireThread(threadId);
  const thread = latestActiveThread();
  if (!thread) throw new Error('No active thread to continue');
  return thread;
}

export function replHistoryFile() {
  return process.env.COVEN_CODE_REPL_HISTORY_FILE
    || path.join(configDir(), CONFIG_SUBDIR, 'repl_history');
}

export function loadReplHistory() {
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

export async function appendReplHistory(line) {
  if (process.env.COVEN_CODE_REPL_HISTORY === '0') return;
  try {
    const file = replHistoryFile();
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${line}\n`);
  } catch {
    // history must never break the REPL
  }
}
