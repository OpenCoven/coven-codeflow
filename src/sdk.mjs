import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeThreadVisibility, readThread, writeThread } from './threads/store.mjs';
import { parseJsonc } from './settings/load.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const covenCodeBin = path.join(repoRoot, 'bin', 'coven-code.mjs');

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

function executeArgs(prompt, options, isStreamInput) {
  const args = ['--execute'];
  if (!isStreamInput) args.push(String(prompt));
  args.push(options.thinking ? '--stream-json-thinking' : '--stream-json');
  if (isStreamInput) args.push('--stream-json-input');
  if (options.dangerouslyAllowAll) args.push('--dangerously-allow-all');
  if (options.archive) args.push('--archive');
  if (options.mode) args.push('--mode', options.mode);
  if (options.reasoningEffort) args.push('--reasoning-effort', options.reasoningEffort);
  const visibility = normalizeSdkThreadVisibility(options.visibility) ?? (options.continue ? undefined : 'workspace');
  if (visibility) args.push('--visibility', visibility);
  if (options.settingsFile) args.push('--settings-file', options.settingsFile);
  if (options.continue) args.push('--continue', ...(typeof options.continue === 'string' ? [options.continue] : []));
  if (options.toolbox) args.push('--toolbox', options.toolbox);
  if (options.skills) args.push('--skills', options.skills);
  if (options.mcpConfig) args.push('--mcp-config', typeof options.mcpConfig === 'string' ? options.mcpConfig : JSON.stringify(options.mcpConfig));
  for (const label of options.labels ?? []) args.push('--label', label);
  return args;
}

function normalizeSdkThreadVisibility(visibility) {
  if (visibility === 'team') return 'workspace';
  return normalizeThreadVisibility(visibility);
}

async function writeStreamInput(child, prompt, signal) {
  const iterator = prompt[Symbol.asyncIterator]();
  try {
    while (true) {
      const { value: message, done } = await nextWithAbort(iterator, signal);
      if (done) break;
      if (child.stdin.destroyed) break;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    child.stdin.end();
  } catch (error) {
    if (!isAbortError(error)) throw error;
    child.stdin.destroy();
    try {
      iterator.return?.().catch?.(() => {});
    } catch {
      // Best-effort generator cleanup; abort should not wait on a slow prompt source.
    }
  }
}

function nextWithAbort(iterator, signal) {
  if (!signal) return iterator.next();
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    iterator.next().then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || /abort/i.test(error?.message ?? '');
}

async function closeStdin(child) {
  child.stdin.end();
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));
  });
}

function isAsyncIterable(value) {
  return value && typeof value[Symbol.asyncIterator] === 'function';
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

async function withEnv(env = {}, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(env ?? {})) {
    previous.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function prepareRunSettings(options = {}) {
  if (!shouldWriteRunSettings(options)) return { settingsFile: options.settingsFile, cleanup: async () => {} };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'coven-code-sdk-settings-'));
  const settingsFile = path.join(dir, 'settings.json');
  const baseSettings = options.settingsFile ? await readJsonSettings(sdkOptionsPath(options.settingsFile, options.cwd)) : {};
  const settings = { ...baseSettings };
  if (Array.isArray(options.permissions)) settings['covenCode.permissions'] = options.permissions;
  if (Array.isArray(options.enabledTools)) settings['covenCode.tools.enable'] = options.enabledTools;
  if (typeof options.systemPrompt === 'string') settings['covenCode.systemPrompt'] = options.systemPrompt;
  if (typeof options.skills === 'string') settings['covenCode.skills.path'] = options.skills;
  await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return {
    settingsFile,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function shouldWriteRunSettings(options = {}) {
  return Array.isArray(options.permissions)
    || Array.isArray(options.enabledTools)
    || typeof options.systemPrompt === 'string'
    || typeof options.skills === 'string';
}

async function readJsonSettings(filePath) {
  try {
    return parseJsonc(await readFile(filePath, 'utf8'));
  } catch {
    return {};
  }
}

async function writeDebugLog(options = {}, covenCodeCommand = resolveCovenCodeCommand(), args = []) {
  if (options.logLevel !== 'debug') return;
  const line = `level=debug cwd=${options.cwd ?? process.cwd()} argv=${[covenCodeCommand.command, ...covenCodeCommand.args, ...args].map(JSON.stringify).join(' ')}\n`;
  process.stderr.write(line);
  if (!options.logFile) return;
  const logFile = sdkOptionsPath(options.logFile, options.cwd);
  await mkdir(path.dirname(logFile), { recursive: true });
  await appendFile(logFile, line, 'utf8');
}

function sdkOptionsPath(filePath, cwd = process.cwd()) {
  if (!filePath || path.isAbsolute(filePath)) return filePath;
  return path.resolve(cwd, filePath);
}

function resolveCovenCodeCommand() {
  const cliPath = process.env.COVEN_CODE_CLI_PATH;
  if (cliPath && existsSync(cliPath)) {
    return isNodeScriptPath(cliPath)
      ? { command: process.execPath, args: [cliPath] }
      : { command: cliPath, args: [] };
  }
  return { command: process.execPath, args: [covenCodeBin] };
}

function isNodeScriptPath(filePath) {
  return filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs');
}
