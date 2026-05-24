import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export function globMatch(pattern, value) {
  const re = new RegExp(`^${String(pattern).split('*').map(escapeRegex).join('.*')}$`);
  return re.test(value);
}

export function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

export function hasGlob(rawPath) {
  return /[*?]/.test(rawPath);
}

export function globToRegex(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += `[^${escapeRegex(path.sep)}]*`;
    } else if (char === '?') {
      source += `[^${escapeRegex(path.sep)}]`;
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

export function walkFiles(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const files = [];
  for (const entry of readdirSync(dir)) {
    const filePath = path.join(dir, entry);
    const stat = statSync(filePath);
    if (stat.isDirectory()) files.push(...walkFiles(filePath));
    else if (stat.isFile()) files.push(filePath);
  }
  return files;
}
