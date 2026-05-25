import { readFileSync } from 'node:fs';
import { listSkills } from '../skills/discover.mjs';
import { UsageError } from '../cli/parse.mjs';
import { printRows } from '../util/table.mjs';

export async function runSkill(args, parsed = {}) {
  const subcommand = args[0] ?? 'list';

  if (subcommand === 'list') {
    const rows = listSkills({ parsed }).map((skill) => [skill.name, skill.source, skill.description]);
    printRows(rows.length ? rows : [['(none)', '-', '-']]);
    return;
  }

  if (subcommand === 'show') {
    const skill = listSkills({ parsed }).find((candidate) => candidate.name === args[1]);
    if (!skill) throw new UsageError(`Unknown skill: ${args[1] ?? ''}`);
    process.stdout.write(readFileSync(skill.filePath, 'utf8'));
    return;
  }

  throw new UsageError(`Unknown skill command: ${subcommand}`);
}
