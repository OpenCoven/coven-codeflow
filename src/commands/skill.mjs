import { readFileSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { configDir } from '../settings/paths.mjs';
import { findSkill, listSkills, readSkillMetadata } from '../skills/discover.mjs';
import { resolveSkillSource } from '../skills/install.mjs';
import { UsageError } from '../cli/parse.mjs';
import { printRows } from '../util/table.mjs';

export async function runSkill(args) {
  const subcommand = args[0] ?? 'list';

  if (subcommand === 'add') {
    const source = args[1];
    if (!source) throw new UsageError('skill add requires a local path or git URL');
    const sourceDir = await resolveSkillSource(source);
    const metadata = readSkillMetadata(sourceDir);
    const target = path.join(configDir(), 'amp', 'skills', metadata.name);
    await rm(target, { recursive: true, force: true });
    await cp(sourceDir, target, { recursive: true });
    console.log(`Installed skill ${metadata.name} at ${target}`);
    return;
  }

  if (subcommand === 'list') {
    const rows = listSkills().map((skill) => [skill.name, skill.source, skill.description]);
    printRows(rows.length ? rows : [['(none)', '-', '-']]);
    return;
  }

  if (subcommand === 'show') {
    const skill = findSkill(args[1]);
    if (!skill) throw new UsageError(`Unknown skill: ${args[1] ?? ''}`);
    process.stdout.write(readFileSync(skill.filePath, 'utf8'));
    return;
  }

  if (subcommand === 'remove') {
    const name = args[1];
    if (!name) throw new UsageError('skill remove requires a skill name');
    const skill = listSkills({ includeShadowed: true })
      .find((candidate) => candidate.name === name && candidate.source === 'user');
    if (!skill) throw new UsageError(`No user-wide skill named ${name}`);
    await rm(skill.dir, { recursive: true, force: true });
    console.log(`Removed skill ${name}`);
    return;
  }

  throw new UsageError(`Unknown skill command: ${subcommand}`);
}
