import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_SUBDIR } from '../constants.mjs';
import { configDir } from '../settings/paths.mjs';
import { readEffectiveSettings, readSettingsFile, writeSettingsFile } from '../settings/load.mjs';
import { displayCwd } from '../util/fs.mjs';
import { UsageError } from '../cli/parse.mjs';

export const THREAD_VISIBILITIES = ['private', 'public', 'workspace', 'group', 'unlisted'];
export const THREAD_VISIBILITY_INPUTS = ['private', 'public', 'workspace', 'workspace-shared', 'group', 'group-shared', 'unlisted'];

export function threadsDir() {
  return path.join(configDir(), CONFIG_SUBDIR, 'threads');
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
  return [
    thread.id,
    thread.title,
    thread.cwd,
    thread.createdAt,
    thread.updatedAt,
    ...(thread.labels ?? []),
    ...(thread.messages ?? []).map((message) => message.content),
  ].join(' ');
}

export function defaultThreadVisibility(parsed = {}) {
  const configured = readEffectiveSettings(parsed)['covenCode.defaultVisibility'];
  const originKey = currentRepositoryOriginKey();
  const visibility = typeof configured === 'string'
    ? configured
    : configured?.[originKey] ?? configured?.default;
  return normalizeThreadVisibility(parsed.visibility) ?? normalizeThreadVisibility(visibility) ?? 'private';
}

export function normalizeThreadVisibility(visibility) {
  if (visibility === 'workspace-shared') return 'workspace';
  if (visibility === 'group-shared') return 'group';
  return THREAD_VISIBILITIES.includes(visibility) ? visibility : undefined;
}

export async function saveThread(id, prompt, result, mode, parsed = {}) {
  return saveThreadMessages(id, [
    { role: 'user', content: prompt },
    { role: 'assistant', content: result },
  ], mode, parsed);
}

export async function persistThreadTurn(id, prompt, result, mode, thread, parsed = {}) {
  return persistThreadMessages(id, [
    { role: 'user', content: prompt },
    { role: 'assistant', content: result },
  ], mode, thread, parsed);
}

export async function saveThreadMessages(id, messages, mode, parsed = {}) {
  const now = new Date().toISOString();
  const firstUser = messages.find((message) => message.role === 'user')?.content ?? '';
  const existing = readThread(id);
  const thread = {
    id,
    title: existing?.title === '(pending thread)' || !existing?.title
      ? firstUser.split(/\r?\n/).find(Boolean)?.slice(0, 120) || '(empty prompt)'
      : existing.title,
    cwd: displayCwd(),
    mode,
    visibility: defaultThreadVisibility(parsed),
    labels: normalizedLabels(parsed.labels),
    archived: Boolean(parsed.archive),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messages: [...(existing?.messages ?? []), ...messages],
  };
  await writeThread(thread);
  return thread;
}

export async function persistThreadMessages(id, messages, mode, thread, parsed = {}) {
  if (!thread) {
    return saveThreadMessages(id, messages, mode, parsed);
  }
  thread.mode = mode;
  thread.visibility = normalizeThreadVisibility(parsed.visibility) ?? thread.visibility;
  thread.labels = mergeLabels(thread.labels, parsed.labels);
  if (parsed.archive) thread.archived = true;
  thread.updatedAt = new Date().toISOString();
  thread.messages.push(...messages);
  await writeThread(thread);
  return thread;
}

export function threadContinuationPrompt(thread, prompt) {
  return `[thread:${thread.id}]\n${thread.messages.map((message) => `${message.role}: ${message.content}`).join('\n')}\n[/thread]\n${prompt}`;
}

function normalizedLabels(labels = []) {
  return [...new Set(labels.map((label) => String(label).trim()).filter(Boolean))];
}

function mergeLabels(existing = [], labels = []) {
  return [...new Set([...existing, ...normalizedLabels(labels)])];
}

function currentRepositoryOriginKey() {
  const configPath = findGitConfig(process.cwd());
  if (!configPath) return undefined;
  try {
    const config = readFileSync(configPath, 'utf8');
    const originUrl = config.match(/\[remote "origin"\][\s\S]*?\n\s*url\s*=\s*([^\r\n]+)/)?.[1]?.trim();
    return normalizeGitOrigin(originUrl);
  } catch {
    return undefined;
  }
}

function findGitConfig(cwd) {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, '.git', 'config');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current || current === path.resolve(configDir(), '..')) return undefined;
    current = parent;
  }
}

function normalizeGitOrigin(originUrl = '') {
  const text = originUrl.replace(/\.git$/, '');
  const scp = text.match(/^git@([^:]+):(.+)$/);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(text);
    const pathName = url.pathname.replace(/^\/+/, '');
    return pathName ? `${url.hostname}/${pathName}` : undefined;
  } catch {
    return undefined;
  }
}
