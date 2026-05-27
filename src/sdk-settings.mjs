import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './settings/load.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const covenCodeBin = path.join(repoRoot, 'bin', 'coven-code.mjs');

export async function withEnv(env = {}, fn) {
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

export async function prepareRunSettings(options = {}) {
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

export async function writeDebugLog(options = {}, covenCodeCommand = resolveCovenCodeCommand(), args = []) {
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

export function resolveCovenCodeCommand() {
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
