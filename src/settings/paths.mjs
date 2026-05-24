import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configDir() {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

export function toolsDirs() {
  if (Object.hasOwn(process.env, 'AMP_TOOLBOX')) {
    if (process.env.AMP_TOOLBOX === '') return [];
    return process.env.AMP_TOOLBOX.split(path.delimiter).filter(Boolean);
  }
  return [path.join(configDir(), 'amp', 'tools')];
}

export function writableToolsDir() {
  return toolsDirs()[0] || path.join(configDir(), 'amp', 'tools');
}

export function workspaceSettingsFile(cwd) {
  return path.join(cwd, '.amp', 'settings.json');
}

export function findWorkspaceSettingsFile(cwd) {
  let current = path.resolve(cwd);
  while (true) {
    for (const name of ['settings.json', 'settings.jsonc']) {
      const candidate = path.join(current, '.amp', name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function findUserSettingsFile() {
  const dir = path.join(configDir(), 'amp');
  for (const name of ['settings.json', 'settings.jsonc']) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function findManagedSettingsFile() {
  if (process.env.AMP_MANAGED_SETTINGS_FILE) return process.env.AMP_MANAGED_SETTINGS_FILE;
  const candidates = [];
  if (process.platform === 'win32') {
    if (process.env.ProgramData) candidates.push(path.join(process.env.ProgramData, 'ampcode', 'managed-settings.json'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Library/Application Support/ampcode/managed-settings.json');
  } else {
    candidates.push('/etc/ampcode/managed-settings.json');
  }
  return candidates.find((candidate) => existsSync(candidate));
}

export function settingsFile(parsed = {}) {
  if (parsed.settingsFile || process.env.AMP_SETTINGS_FILE) {
    return parsed.settingsFile || process.env.AMP_SETTINGS_FILE;
  }
  return findUserSettingsFile() || path.join(configDir(), 'amp', 'settings.json');
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

export function expandHomePath(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}
