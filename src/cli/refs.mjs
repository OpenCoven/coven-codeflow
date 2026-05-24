import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FILE_MENTION_MAX_LINES, FILE_MENTION_MAX_LINE_LENGTH } from '../constants.mjs';
import { globToRegex, hasGlob, walkFiles } from '../util/glob.mjs';
import { readThread } from '../threads/store.mjs';

export function expandFileReferences(prompt, options = {}) {
  return prompt.replace(/@(?!(?:T-|@))((?:~|\/|\.{1,2}\/)?[A-Za-z0-9_./*?-]+\.[A-Za-z0-9_*-]+)/g, (match, rawPath) => {
    const blocks = mentionedFiles(rawPath, options)
      .map((filePath) => fileMentionBlock(filePath, options))
      .filter(Boolean);
    if (blocks.length === 0) return match;
    return blocks.join('\n');
  });
}

function fileMentionBlock(filePath, options = {}) {
  const image = imageMentionBlock(filePath);
  if (image) return image;
  const content = readMentionedTextFile(filePath);
  if (content === undefined) return undefined;
  if (options.includeFile && !options.includeFile(filePath, content)) return undefined;
  return `[file:${filePath}]\n${content}\n[/file]`;
}

export function imageMentionBlock(filePath) {
  const mediaType = imageMediaType(filePath);
  if (!mediaType) return undefined;
  const bytes = readFileSync(filePath).byteLength;
  return `[image:${filePath}]\nmedia_type: ${mediaType}\nbytes: ${bytes}\n[/image]`;
}

function imageMediaType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return undefined;
}

function readMentionedTextFile(filePath) {
  const raw = readFileSync(filePath);
  if (raw.includes(0)) return undefined;
  const text = raw.toString('utf8');
  return text
    .split(/\r?\n/)
    .slice(0, FILE_MENTION_MAX_LINES)
    .map((line) => line.slice(0, FILE_MENTION_MAX_LINE_LENGTH))
    .join('\n');
}

function mentionedFiles(rawPath, options = {}) {
  if (!hasGlob(rawPath)) {
    const filePath = resolveMentionedPath(rawPath, options);
    return existsSync(filePath) && statSync(filePath).isFile() ? [filePath] : [];
  }
  const root = globSearchRoot(rawPath, options);
  const pattern = rawPath.startsWith('~/')
    ? path.join(os.homedir(), rawPath.slice(2))
    : path.resolve(options.baseDir ?? process.cwd(), rawPath);
  const re = globToRegex(path.normalize(pattern));
  return walkFiles(root)
    .filter((filePath) => re.test(path.normalize(filePath)))
    .sort((a, b) => a.localeCompare(b));
}

function resolveMentionedPath(rawPath, options = {}) {
  if (rawPath.startsWith('~/')) return path.join(os.homedir(), rawPath.slice(2));
  if (path.isAbsolute(rawPath)) return rawPath;
  return path.resolve(options.baseDir ?? process.cwd(), rawPath);
}

function globSearchRoot(rawPath, options = {}) {
  const pattern = resolveMentionedPath(rawPath, options);
  const parts = pattern.split(path.sep);
  const stableParts = [];
  for (const part of parts) {
    if (hasGlob(part)) break;
    stableParts.push(part);
  }
  const root = stableParts.join(path.sep) || path.sep;
  return existsSync(root) && statSync(root).isDirectory() ? root : path.dirname(root);
}

export function expandThreadReferences(prompt) {
  return prompt.replace(/(?:@|https:\/\/ampcode\.com\/threads\/)(T-[A-Za-z0-9-]+)/g, (match, threadId) => {
    const thread = readThread(threadId);
    if (!thread) return match;
    return `[thread:${thread.id}]\n${thread.messages.map((message) => `${message.role}: ${message.content}`).join('\n')}\n[/thread]`;
  });
}
