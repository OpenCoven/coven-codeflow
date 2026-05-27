import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findManagedSettingsFile, findWorkspaceSettingsFile, settingsFile } from './paths.mjs';

export const SETTINGS_PREFIX = 'covenCode.';

export function readSettings(parsed = {}) {
  return readSettingsFile(settingsFile(parsed));
}

export function readEffectiveSettings(parsed = {}, options = {}) {
  const userSettings = readSettings(parsed);
  const workspacePath = findWorkspaceSettingsFile(options.cwd ?? process.cwd());
  const workspaceSettings = workspacePath ? readSettingsFile(workspacePath) : {};
  return { ...userSettings, ...workspaceSettings, ...readManagedSettings() };
}

export function readManagedSettings() {
  return readSettingsFile(findManagedSettingsFile());
}

export async function writeSettings(settings, parsed = {}) {
  await writeSettingsFile(settingsFile(parsed), settings);
}

export function readSettingsFile(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  const text = readFileSync(filePath, 'utf8');
  if (!text.trim()) return {};
  try {
    return parseJsonc(text);
  } catch (error) {
    console.error(`coven-code: settings file ${filePath} is invalid JSON, using defaults: ${error?.message ?? error}`);
    return {};
  }
}

export async function writeSettingsFile(filePath, settings) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

export function parseJsonc(text) {
  return JSON.parse(removeJsonTrailingCommas(stripJsonComments(text)));
}

function stripJsonComments(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      if (index < text.length) output += text[index];
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }

    output += char;
  }
  return output;
}

function removeJsonTrailingCommas(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === ',') {
      let lookahead = index + 1;
      while (/\s/.test(text[lookahead] ?? '')) lookahead += 1;
      if (text[lookahead] === '}' || text[lookahead] === ']') continue;
    }

    output += char;
  }
  return output;
}

export function readFrontmatter(text) {
  const metadata = {};
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return metadata;
  for (const line of match[1].split(/\r?\n/)) {
    const entry = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (entry) metadata[entry[1]] = entry[2].replace(/^["']|["']$/g, '');
  }
  return metadata;
}

export function splitListValue(value) {
  const text = String(value).trim();
  if (text.startsWith('[') && text.endsWith(']')) {
    return text.slice(1, -1).split(',').map((entry) => entry.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return text.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean);
}
