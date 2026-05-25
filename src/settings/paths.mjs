import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_SUBDIR, PROJECT_SUBDIR } from '../constants.mjs';

const TOOLBOX_ENV = 'COVEN_CODE_TOOLBOX';
const SETTINGS_FILE_ENV = 'COVEN_CODE_SETTINGS_FILE';
const MANAGED_SETTINGS_FILE_ENV = 'COVEN_CODE_MANAGED_SETTINGS_FILE';

export function configDir() {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

export function toolsDirs(parsed = {}) {
  if (parsed.toolbox) return parsed.toolbox.split(path.delimiter).filter(Boolean).map(expandHomePath);
  if (Object.hasOwn(process.env, TOOLBOX_ENV)) {
    if (process.env[TOOLBOX_ENV] === '') return [];
    return process.env[TOOLBOX_ENV].split(path.delimiter).filter(Boolean);
  }
  return [path.join(configDir(), CONFIG_SUBDIR, 'tools')];
}

export function writableToolsDir() {
  return toolsDirs()[0] || path.join(configDir(), CONFIG_SUBDIR, 'tools');
}

export function workspaceSettingsFile(cwd) {
  return path.join(cwd, PROJECT_SUBDIR, 'settings.json');
}

export function findWorkspaceSettingsFile(cwd) {
  let current = path.resolve(cwd);
  const boundary = findGitRoot(current) ?? current;
  while (true) {
    for (const name of ['settings.json', 'settings.jsonc']) {
      const candidate = path.join(current, PROJECT_SUBDIR, name);
      if (existsSync(candidate)) return candidate;
    }
    if (current === boundary) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function findUserSettingsFile() {
  const dir = path.join(configDir(), CONFIG_SUBDIR);
  for (const name of ['settings.json', 'settings.jsonc']) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function findManagedSettingsFile() {
  if (process.env[MANAGED_SETTINGS_FILE_ENV]) return process.env[MANAGED_SETTINGS_FILE_ENV];
  const candidates = [];
  if (process.platform === 'win32') {
    if (process.env.ProgramData) {
      candidates.push(path.join(process.env.ProgramData, CONFIG_SUBDIR, 'managed-settings.json'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Library/Application Support/coven-code/managed-settings.json');
  } else {
    candidates.push('/etc/coven-code/managed-settings.json');
  }
  return candidates.find((candidate) => existsSync(candidate));
}

export function settingsFile(parsed = {}) {
  if (parsed.settingsFile || process.env[SETTINGS_FILE_ENV]) {
    return parsed.settingsFile || process.env[SETTINGS_FILE_ENV];
  }
  return findUserSettingsFile() || path.join(configDir(), CONFIG_SUBDIR, 'settings.json');
}

export function findProjectRoot(cwd) {
  let current = cwd;
  while (true) {
    if (existsSync(path.join(current, 'package.json')) || existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current || current === os.homedir()) return cwd;
    current = parent;
  }
}

function findGitRoot(cwd) {
  let current = path.resolve(cwd);
  while (true) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current || current === os.homedir()) return undefined;
    current = parent;
  }
}

export function expandHomePath(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}
