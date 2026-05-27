import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AGENT_MODES, CLI_NAME, CONFIG_SUBDIR, REPL_HISTORY_LIMIT } from '../constants.mjs';
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
import {
  buildSlashCommandCatalog,
  findSlashCommand,
  formatSlashCommandDetails,
  formatSlashHelpLines,
  skillPromptFromSlashCommand,
} from './slash-commands.mjs';

export function createInteractiveSession(parsed, options = {}) {
  return {
    parsed,
    thread: options.thread,
    cwd: options.cwd ?? process.cwd(),
    queuedMessages: [],
    silent: options.silent ?? false,
    commandRunner: options.commandRunner ?? runCommand,
    executeRunner: options.executeRunner ?? runExecute,
    editorReader: options.editorReader ?? readEditorPrompt,
  };
}

export async function handleInteractiveInput(session, text) {
  if (!text) return { kind: 'empty', lines: [] };
  if (text === '/exit' || text === '/quit') return { kind: 'exit', lines: [] };
  if (text === '/help') return { kind: 'help', lines: await sessionSlashHelpLines(session) };
  if (!text.startsWith('/')) {
    session.thread = await runInteractiveTurn(session.parsed, text, session.thread, session.executeRunner, { silent: session.silent });
    while (session.queuedMessages.length > 0) {
      session.thread = await runInteractiveTurn(session.parsed, session.queuedMessages.shift(), session.thread, session.executeRunner, { silent: session.silent });
    }
    return { kind: 'turn', lines: [] };
  }

  const tokens = splitShellWords(text.slice(1));
  const [cmd, ...rest] = tokens;
  const catalog = await safeSlashCommandCatalog(session);
  if (!cmd) return { kind: 'help', lines: formatCatalogHelpLines(catalog) };
  const catalogEntry = findSlashCommand(catalog, cmd);

  if (catalogEntry?.source === 'skill') {
    if (rest.length === 0) {
      return { kind: 'command', lines: formatSlashCommandDetails(catalogEntry) };
    }
    await submitPromptAndQueue(session, skillPromptFromSlashCommand(catalogEntry, rest.join(' ')));
    return { kind: 'turn', lines: [] };
  }

  if (catalogEntry?.source === 'plugin' && catalogEntry.availability?.type === 'disabled') {
    return {
      kind: 'error',
      lines: [`${CLI_NAME}: ${catalogEntry.availability.reason ?? `Plugin command disabled: ${catalogEntry.name}`}`],
    };
  }

  if (cmd === 'mode') {
    const nextMode = rest[0];
    if (!nextMode) return { kind: 'command', lines: [`mode: ${session.parsed.mode}`] };
    if (!AGENT_MODES.includes(nextMode)) return { kind: 'error', lines: [`${CLI_NAME}: Unknown mode: ${nextMode}`] };
    session.parsed.mode = nextMode;
    session.parsed.reasoningEffort = coerceReasoningEffortForMode(session.parsed.mode, session.parsed.reasoningEffort);
    return { kind: 'command', lines: [`mode: ${session.parsed.mode}`, `reasoning effort: ${session.parsed.reasoningEffort}`] };
  }

  if (cmd === 'reasoning') {
    try {
      const nextEffort = rest[0] === 'next'
        ? nextReasoningEffortForMode(session.parsed.mode, session.parsed.reasoningEffort)
        : rest[0];
      session.parsed.reasoningEffort = reasoningEffortForMode(session.parsed.mode, nextEffort ?? session.parsed.reasoningEffort);
      return { kind: 'command', lines: [`reasoning effort: ${session.parsed.reasoningEffort}`] };
    } catch (error) {
      return { kind: 'error', lines: [`${CLI_NAME}: ${error?.message ?? error}`] };
    }
  }

  if (cmd === 'queue') {
    const queued = rest.join(' ').trim();
    if (!queued) return { kind: 'error', lines: [`${CLI_NAME}: /queue requires a prompt`] };
    session.queuedMessages.push(queued);
    return { kind: 'command', lines: [`queued: ${queued}`] };
  }

  if (cmd === 'new') {
    session.thread = undefined;
    return { kind: 'command', lines: ['new thread'] };
  }

  if (cmd === 'continue') {
    try {
      session.thread = interactiveContinuationThread(rest[0]);
      return { kind: 'command', lines: [`continued: ${session.thread.id}`] };
    } catch (error) {
      return { kind: 'error', lines: [`${CLI_NAME}: ${error?.message ?? error}`] };
    }
  }

  if (cmd === `${CLI_NAME}:` && rest.join(' ') === 'help') return { kind: 'help', lines: await sessionSlashHelpLines(session) };

  if (cmd === 'editor') {
    const edited = await session.editorReader();
    if (edited) await submitPromptAndQueue(session, edited);
    return { kind: 'command', lines: [] };
  }

  if (cmd === 'edit') {
    try {
      if (!session.thread) throw new Error('No current thread to edit');
      const editTarget = editablePreviousPrompt(session.thread);
      const edited = await session.editorReader(editTarget.prompt);
      if (edited) {
        session.thread.messages = session.thread.messages.slice(0, editTarget.index);
        if (session.thread.messages.length === 0) {
          session.thread.title = edited.split(/\r?\n/).find(Boolean)?.slice(0, 120) || '(empty prompt)';
        }
        await submitPromptAndQueue(session, edited);
      }
      return { kind: 'command', lines: [] };
    } catch (error) {
      return { kind: 'error', lines: [`${CLI_NAME}: ${error?.message ?? error}`] };
    }
  }

  if (cmd === 'thread:' && rest.join(' ') === 'archive and quit') {
    try {
      if (!session.thread) throw new Error('No current thread to archive');
      await session.commandRunner('threads', ['archive', session.thread.id], session.parsed, '');
      return { kind: 'exit', lines: [] };
    } catch (error) {
      return { kind: 'error', lines: [`${CLI_NAME}: ${error?.message ?? error}`] };
    }
  }

  if (cmd === 'thread:' && rest[0] === 'set' && rest[1] === 'visibility') {
    try {
      if (!session.thread) throw new Error('No current thread to update');
      await session.commandRunner('threads', ['visibility', session.thread.id, ...rest.slice(2)], session.parsed, '');
      return { kind: 'command', lines: [] };
    } catch (error) {
      return { kind: 'error', lines: [`${CLI_NAME}: ${error?.message ?? error}`] };
    }
  }

  if (cmd === 'feedback:' && rest.join(' ') === 'send report with diagnostics') {
    try {
      if (!session.thread) throw new Error('No current thread to report');
      await session.commandRunner('threads', ['report', session.thread.id], session.parsed, '');
      return { kind: 'command', lines: [] };
    } catch (error) {
      return { kind: 'error', lines: [`${CLI_NAME}: ${error?.message ?? error}`] };
    }
  }

  try {
    if (cmd === 'skill:') await session.commandRunner('skill', rest, session.parsed, '');
    else if (cmd === 'plugins:') await session.commandRunner('plugins', rest, session.parsed, '');
    else await session.commandRunner(cmd, rest, session.parsed, '');
    return { kind: 'command', lines: [] };
  } catch (error) {
    if (String(error?.message ?? '').startsWith('Unknown command:')) {
      try {
        await session.commandRunner('plugins', ['run', cmd], session.parsed, '');
        return { kind: 'command', lines: [] };
      } catch (pluginError) {
        if (!String(pluginError?.message ?? '').startsWith('Unknown plugin command:')) throw pluginError;
      }
    }
    return { kind: 'error', lines: [`${CLI_NAME}: ${error?.message ?? error}`] };
  }
}

async function submitPromptAndQueue(session, text) {
  session.thread = await runInteractiveTurn(session.parsed, text, session.thread, session.executeRunner, { silent: session.silent });
  while (session.queuedMessages.length > 0) {
    session.thread = await runInteractiveTurn(session.parsed, session.queuedMessages.shift(), session.thread, session.executeRunner, { silent: session.silent });
  }
}

export function slashHelpLines() {
  return formatSlashHelpLines();
}

export function printSlashHelp() {
  for (const line of slashHelpLines()) console.log(line);
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

async function safeSlashCommandCatalog(session) {
  try {
    return await buildSlashCommandCatalog({
      parsed: session.parsed,
      cwd: session.cwd ?? process.cwd(),
    });
  } catch {
    return [];
  }
}

async function sessionSlashHelpLines(session) {
  return formatCatalogHelpLines(await safeSlashCommandCatalog(session));
}

function formatCatalogHelpLines(catalog) {
  return catalog.length > 0 ? formatSlashHelpLines(catalog) : slashHelpLines();
}
