import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, expandHomePath } from '../settings/paths.mjs';
import { readSettings } from '../settings/load.mjs';
import { UsageError } from '../cli/parse.mjs';

export function listSkills(options = {}) {
  const seen = new Set();
  const skills = [];
  for (const root of skillSearchRoots()) {
    if (!existsSync(root.dir)) continue;
    for (const entry of readdirSync(root.dir)) {
      const dir = path.join(root.dir, entry);
      const filePath = path.join(dir, 'SKILL.md');
      if (!existsSync(filePath) || !statSync(dir).isDirectory()) continue;
      const metadata = readSkillMetadata(dir);
      const skill = { ...metadata, dir, filePath, source: root.source };
      if (options.includeShadowed || !seen.has(skill.name)) skills.push(skill);
      seen.add(skill.name);
    }
  }
  return skills;
}

export function findSkill(name) {
  return listSkills().find((skill) => skill.name === name);
}

export function skillSearchRoots() {
  const ampNativeRoots = [
    { source: 'project', dir: path.join(process.cwd(), '.agents', 'skills') },
    { source: 'user', dir: path.join(configDir(), 'agents', 'skills') },
    { source: 'user', dir: path.join(configDir(), 'amp', 'skills') },
    ...configuredSkillRoots(),
  ];
  if (readSettings({})['amp.skills.disableClaudeCodeSkills'] === true) return ampNativeRoots;
  return [
    ampNativeRoots[0],
    { source: 'project', dir: path.join(process.cwd(), '.claude', 'skills') },
    ...ampNativeRoots.slice(1),
    { source: 'user', dir: path.join(os.homedir(), '.claude', 'skills') },
  ];
}

function configuredSkillRoots() {
  const rawPath = readSettings({})['amp.skills.path'];
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return [];
  return rawPath
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => ({ source: 'user', dir: expandHomePath(entry) }));
}

export function readSkillMetadata(dir) {
  const filePath = path.join(dir, 'SKILL.md');
  if (!existsSync(filePath)) throw new UsageError(`Skill at ${dir} is missing SKILL.md`);
  const text = readFileSync(filePath, 'utf8');
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
  const metadata = {};
  if (frontmatter) {
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (match) metadata[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
  return {
    name: metadata.name || path.basename(dir),
    description: metadata.description || '',
  };
}
