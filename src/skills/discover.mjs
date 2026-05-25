import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_SUBDIR } from '../constants.mjs';
import { configDir, expandHomePath } from '../settings/paths.mjs';
import { readSettings } from '../settings/load.mjs';
import { UsageError } from '../cli/parse.mjs';

const BUILTIN_SKILLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'builtin');

export function listSkills(options = {}) {
  const seen = new Set();
  const skills = [];
  for (const root of [...parsedSkillRoots(options.parsed), ...skillSearchRoots()]) {
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
  const userRoots = [
    { source: 'user', dir: path.join(configDir(), 'agents', 'skills') },
    { source: 'user', dir: path.join(configDir(), CONFIG_SUBDIR, 'skills') },
    ...configuredSkillRoots(readSettings({})),
  ];
  const projectRoots = projectSkillRoots('.agents', 'skills');
  if (readSettings({})['covenCode.skills.disableLegacySkillRoots'] === true) return [...userRoots, ...projectRoots];
  return [
    ...userRoots,
    ...projectRoots,
    ...projectSkillRoots('.claude', 'skills'),
    { source: 'user', dir: path.join(os.homedir(), '.claude', 'skills') },
    { source: 'built-in', dir: BUILTIN_SKILLS_DIR },
  ];
}

function projectSkillRoots(...parts) {
  const roots = [];
  const home = os.homedir();
  let current = path.resolve(process.cwd());
  while (true) {
    roots.push({ source: 'project', dir: path.join(current, ...parts) });
    if (current === home || current === path.dirname(current)) break;
    current = path.dirname(current);
  }
  return roots;
}

export function parsedSkillRoots(parsed = {}) {
  return splitSkillPath(parsed.skills).map((entry) => ({ source: 'cli', dir: expandHomePath(entry) }));
}

function configuredSkillRoots(settings) {
  const rawPath = settings['covenCode.skills.path'];
  return splitSkillPath(rawPath).map((entry) => ({ source: 'user', dir: expandHomePath(entry) }));
}

function splitSkillPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return [];
  return rawPath
    .split(path.delimiter)
    .filter(Boolean);
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
