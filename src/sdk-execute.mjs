import { normalizeThreadVisibility } from './threads/store.mjs';

export function executeArgs(prompt, options, isStreamInput) {
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

export function normalizeSdkThreadVisibility(visibility) {
  if (visibility === 'team') return 'workspace';
  return normalizeThreadVisibility(visibility);
}

export async function writeStreamInput(child, prompt, signal) {
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

export async function closeStdin(child) {
  child.stdin.end();
}

export function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));
  });
}

export function isAsyncIterable(value) {
  return value && typeof value[Symbol.asyncIterator] === 'function';
}
