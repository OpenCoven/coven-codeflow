import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { configDir } from '../settings/paths.mjs';
import { readSettingsFile, writeSettingsFile } from '../settings/load.mjs';
import { displayCwd } from '../util/fs.mjs';
import { UsageError } from '../cli/parse.mjs';

export function threadsDir() {
  return path.join(configDir(), 'amp', 'threads');
}

export function threadFile(id) {
  return path.join(threadsDir(), `${id}.json`);
}

export function readThread(id) {
  const filePath = threadFile(id);
  if (!existsSync(filePath)) return undefined;
  return readSettingsFile(filePath);
}

export function listThreads() {
  const dir = threadsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => readSettingsFile(path.join(dir, entry)))
    .filter((thread) => thread.id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function latestActiveThread() {
  return listThreads()
    .filter((thread) => !thread.archived)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
}

export async function writeThread(thread) {
  await writeSettingsFile(threadFile(thread.id), thread);
}

export function requireThread(id) {
  if (!id) throw new UsageError('threads command requires a thread id');
  const thread = readThread(id);
  if (!thread) throw new UsageError(`Unknown thread: ${id}`);
  return thread;
}

export function threadSearchText(thread) {
  return `${thread.id} ${thread.title} ${thread.cwd} ${thread.messages.map((message) => message.content).join(' ')}`;
}

export async function saveThread(id, prompt, result, mode) {
  const now = new Date().toISOString();
  const thread = {
    id,
    title: prompt.split(/\r?\n/).find(Boolean)?.slice(0, 120) || '(empty prompt)',
    cwd: displayCwd(),
    mode,
    archived: false,
    createdAt: now,
    updatedAt: now,
    messages: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: result },
    ],
  };
  await writeThread(thread);
  return thread;
}

export async function persistThreadTurn(id, prompt, result, mode, thread) {
  if (!thread) {
    return saveThread(id, prompt, result, mode);
  }
  thread.mode = mode;
  thread.updatedAt = new Date().toISOString();
  thread.messages.push(
    { role: 'user', content: prompt },
    { role: 'assistant', content: result },
  );
  await writeThread(thread);
  return thread;
}

export function threadContinuationPrompt(thread, prompt) {
  return `[thread:${thread.id}]\n${thread.messages.map((message) => `${message.role}: ${message.content}`).join('\n')}\n[/thread]\n${prompt}`;
}
