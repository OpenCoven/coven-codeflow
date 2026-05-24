import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UsageError } from '../cli/parse.mjs';

export async function resolveSkillSource(source) {
  if (!isGitSkillSource(source)) return source;
  const cloneRoot = await mkdtemp(path.join(os.tmpdir(), 'amp-skill-'));
  const result = spawnSync('git', ['clone', '--depth', '1', gitCloneUrl(source), cloneRoot], {
    env: process.env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new UsageError(`Unable to clone skill source ${source}: ${result.stderr || result.stdout}`);
  }
  const subdir = gitSkillSubdir(source);
  return subdir ? path.join(cloneRoot, subdir) : cloneRoot;
}

function isGitSkillSource(source) {
  return /^(?:https?:\/\/|ssh:\/\/|git@|file:\/\/)/.test(source)
    || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/.+)?$/.test(source);
}

function gitCloneUrl(source) {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/.+)?$/.test(source)) {
    const [owner, repo] = source.split('/');
    return `https://github.com/${owner}/${repo}.git`;
  }
  return source;
}

function gitSkillSubdir(source) {
  const shorthand = source.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(.+)$/);
  return shorthand?.[3] ?? '';
}
