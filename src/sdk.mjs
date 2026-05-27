import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { normalizeThreadVisibility, readThread, writeThread } from './threads/store.mjs';
import {
  closeStdin,
  executeArgs,
  isAsyncIterable,
  waitForExit,
  writeStreamInput,
} from './sdk-execute.mjs';
import {
  prepareRunSettings,
  resolveCovenCodeCommand,
  withEnv,
  writeDebugLog,
} from './sdk-settings.mjs';

export const threads = {
  async new(options = {}) {
    return withEnv(options.env, async () => {
      const now = new Date().toISOString();
      const thread = {
        id: `T-${randomUUID()}`,
        title: '(empty thread)',
        cwd: options.cwd ?? process.cwd(),
        mode: options.mode ?? 'smart',
        visibility: normalizeSdkThreadVisibility(options.visibility) ?? 'private',
        labels: [],
        archived: false,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      await writeThread(thread);
      return thread.id;
    });
  },

  async markdown({ threadId, env } = {}) {
    if (!threadId) throw new Error('threads.markdown requires threadId');
    return withEnv(env, async () => threadMarkdown(requireSdkThread(threadId)));
  },
};

export async function* execute({ prompt, options = {}, signal } = {}) {
  if (prompt === undefined) throw new Error('execute requires a prompt');
  const isStreamInput = isAsyncIterable(prompt);
  const runSettings = await prepareRunSettings(options);
  const args = executeArgs(prompt, { ...options, settingsFile: runSettings.settingsFile }, isStreamInput);
  const covenCodeCommand = resolveCovenCodeCommand();
  const started = Date.now();
  await writeDebugLog(options, covenCodeCommand, args);
  const child = spawn(covenCodeCommand.command, [...covenCodeCommand.args, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    signal,
  });

  let exitError;
  const exitTask = waitForExit(child).catch((error) => {
    exitError = error;
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  let inputError;
  const inputTask = (isStreamInput ? writeStreamInput(child, prompt, signal) : closeStdin(child))
    .catch((error) => {
      inputError = error;
    });
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const closeChildStreams = () => {
    rl.close();
    child.stdout.destroy();
    child.stderr.destroy();
  };
  signal?.addEventListener('abort', closeChildStreams, { once: true });
  let sessionId = `T-${randomUUID()}`;
  let emittedResult = false;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.session_id) sessionId = message.session_id;
      if (message.type === 'result') emittedResult = true;
      yield message;
    }
    await inputTask;
    if (inputError) throw inputError;
    const status = await exitTask;
    if (exitError) throw exitError;
    if (status !== 0 && !emittedResult) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: Date.now() - started,
        is_error: true,
        num_turns: 0,
        error: Buffer.concat(stderr).toString('utf8').trim() || `coven-code exited with status ${status}`,
        session_id: sessionId,
      };
    }
  } finally {
    signal?.removeEventListener('abort', closeChildStreams);
    rl.close();
    await runSettings.cleanup();
  }
}

export function createUserMessage(text) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: String(text) }],
    },
  };
}

export function createPermission(tool, action, options = {}) {
  if (action === 'delegate' && !options.to) {
    throw new Error('delegate action requires "to" option');
  }
  return {
    tool,
    action,
    ...(options.matches ? { matches: options.matches } : {}),
    ...(options.context ? { context: options.context } : {}),
    ...(options.to ? { to: options.to } : {}),
    ...(options.message ? { message: options.message } : {}),
  };
}

function normalizeSdkThreadVisibility(visibility) {
  if (visibility === 'team') return 'workspace';
  return normalizeThreadVisibility(visibility);
}

function requireSdkThread(threadId) {
  const thread = readThread(threadId);
  if (!thread) throw new Error(`Unknown thread: ${threadId}`);
  return thread;
}

function threadMarkdown(thread) {
  const lines = [
    `# Thread ${thread.id}`,
    '',
    `Visibility: ${thread.visibility ?? 'private'}`,
    `Status: ${thread.archived ? 'archived' : 'active'}`,
    `CWD: ${thread.cwd}`,
    '',
  ];
  for (const message of thread.messages ?? []) {
    lines.push(`## ${titleCaseRole(message.role)}`, '', String(message.content), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function titleCaseRole(role = '') {
  return role ? `${role.slice(0, 1).toUpperCase()}${role.slice(1)}` : 'Message';
}
