import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_SUBDIR } from '../constants.mjs';
import { configDir } from '../settings/paths.mjs';
import { UsageError } from '../cli/parse.mjs';

export async function runAgents(args) {
  if ((args[0] ?? 'list') !== 'list') throw new UsageError(`Unknown agents command: ${args[0] ?? ''}`);
  for (const filePath of discoverAgentFiles(process.cwd())) {
    console.log(filePath);
  }
}

export function discoverAgentFiles(cwd) {
  const files = [];
  addFirstGuidanceInDir(files, path.join(configDir(), CONFIG_SUBDIR));
  addFirstGuidanceInDir(files, configDir());
  addFirstGuidanceInDir(files, path.join(os.homedir(), '.config', CONFIG_SUBDIR));
  addFirstGuidanceInDir(files, path.join(os.homedir(), '.config'));
  addFirstGuidanceInDir(files, '/etc/coven-code');
  addFirstGuidanceInDir(files, '/Library/Application Support/coven-code');
  if (process.env.ProgramData) addFirstGuidanceInDir(files, path.join(process.env.ProgramData, CONFIG_SUBDIR));
  if (process.env.PROGRAMDATA) addFirstGuidanceInDir(files, path.join(process.env.PROGRAMDATA, CONFIG_SUBDIR));

  const home = os.homedir();
  let current = path.resolve(cwd);
  while (true) {
    addFirstGuidanceInDir(files, current);
    if (current === home || current === path.dirname(current)) break;
    current = path.dirname(current);
  }

  return [...new Set(files)];
}

function addFirstGuidanceInDir(files, dir) {
  for (const name of ['AGENTS.md', 'AGENT.md', 'CLAUDE.md']) {
    const filePath = path.join(dir, name);
    if (existsSync(filePath)) {
      files.push(filePath);
      return;
    }
  }
}

export function firstGuidanceInDir(dir) {
  for (const name of ['AGENTS.md', 'AGENT.md', 'CLAUDE.md']) {
    const filePath = path.join(dir, name);
    if (existsSync(filePath)) return filePath;
  }
  return undefined;
}
