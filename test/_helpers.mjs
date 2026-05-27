import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const repoRoot = path.resolve(import.meta.dirname, '..');
export const covenCodeBin = path.join(repoRoot, 'bin', 'coven-code.mjs');
export const covenCodeSdkBin = path.join(repoRoot, 'bin', 'coven-code-sdk.mjs');
export const version = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;

export async function makeWorkspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'coven-code-recreate-'));
  await writeFile(path.join(dir, 'README.md'), '# Test Workspace\n');
  await writeFile(path.join(dir, 'AGENTS.md'), 'Use short answers.\n');
  await writeFile(path.join(dir, 'package.json'), '{"name":"fixture"}\n');
  return dir;
}

export function runCovenCode(args, options = {}) {
  return spawnSync(process.execPath, [covenCodeBin, ...args], {
    cwd: options.cwd ?? repoRoot,
    input: options.input,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
  });
}

export function runCovenCodeSdk(args, options = {}) {
  return spawnSync(process.execPath, [covenCodeSdkBin, ...args], {
    cwd: options.cwd ?? repoRoot,
    input: options.input,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
  });
}

export function runGit(args, options = {}) {
  return spawnSync('git', args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
  });
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const expectAvailable = spawnSync('expect', ['-v'], { encoding: 'utf8' }).status === 0;
