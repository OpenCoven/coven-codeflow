import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir } from '../settings/paths.mjs';
import { addIfExists } from '../util/fs.mjs';
import { UsageError } from '../cli/parse.mjs';

export async function runAgents(args) {
  if ((args[0] ?? 'list') !== 'list') throw new UsageError(`Unknown agents command: ${args[0] ?? ''}`);
  for (const filePath of discoverAgentFiles(process.cwd())) {
    console.log(filePath);
  }
}

export function discoverAgentFiles(cwd) {
  const files = [];
  addIfExists(files, path.join(configDir(), 'amp', 'AGENTS.md'));
  addIfExists(files, path.join(configDir(), 'AGENTS.md'));
  addIfExists(files, '/etc/ampcode/AGENTS.md');
  addIfExists(files, '/Library/Application Support/ampcode/AGENTS.md');

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
