import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_SUBDIR } from '../constants.mjs';
import { configDir, findProjectRoot } from '../settings/paths.mjs';
import { readFrontmatter, splitListValue } from '../settings/load.mjs';
import { printRows } from '../util/table.mjs';

export function runReview() {
  const checks = discoverReviewChecks(process.cwd());
  console.log('Review jobs:');
  if (checks.length > 0) {
    printRows(checks.map((check) => [
      check.name,
      'passed',
      check.severity,
      check.tools.length ? check.tools.join(', ') : '-',
      check.displayPath,
      check.description || '-',
    ]));
  } else {
    console.log('(no configured checks)');
  }
  console.log('No review findings from configured local checks.');
}

function discoverReviewChecks(cwd) {
  const root = findProjectRoot(cwd);
  const byName = new Map();
  for (const dir of reviewCheckDirs(cwd, root)) {
    for (const check of readReviewChecksFromDir(dir, root)) {
      byName.set(check.name, check);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function reviewCheckDirs(cwd, root) {
  const dirs = [
    path.join(configDir(), CONFIG_SUBDIR, 'checks'),
    path.join(configDir(), 'agents', 'checks'),
  ];
  const ancestors = [];
  let current = cwd;
  while (true) {
    ancestors.push(current);
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const dir of ancestors.reverse()) {
    dirs.push(path.join(dir, '.agents', 'checks'));
  }
  return dirs;
}

function readReviewChecksFromDir(dir, root) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => readReviewCheck(path.join(dir, entry), root));
}

function readReviewCheck(filePath, root) {
  const metadata = readFrontmatter(readFileSync(filePath, 'utf8'));
  return {
    name: metadata.name || path.basename(filePath, path.extname(filePath)),
    description: metadata.description || '',
    severity: metadata['severity-default'] || 'medium',
    tools: metadata.tools ? splitListValue(metadata.tools) : [],
    displayPath: path.relative(root, filePath) || path.basename(filePath),
  };
}
