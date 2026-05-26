import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const LANE_HARNESSES = ['smart', 'deep', 'rush', 'large'];

export function defaultLaneState(options = {}) {
  return {
    worktree: options.worktree ?? process.cwd(),
    branch: options.branch ?? 'unknown',
    baseBranch: options.baseBranch ?? 'main',
    harness: normalizeLaneHarness(options.harness),
    status: options.status ?? 'unknown',
    changedFiles: options.changedFiles ?? [],
    diffSummary: options.diffSummary ?? '',
    verification: {
      command: options.verification?.command ?? verificationCommandFor(options.worktree ?? process.cwd()),
      status: options.verification?.status ?? 'not run',
    },
    terminalLines: options.terminalLines ?? [],
    pullRequest: options.pullRequest ?? 'not opened',
    merge: options.merge ?? 'not merged',
    cleanup: options.cleanup ?? 'pending',
  };
}

export async function inspectLane(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const runner = options.gitRunner ?? runGit;
  const root = gitText(runner, cwd, ['rev-parse', '--show-toplevel']) || cwd;
  const branch = gitText(runner, root, ['branch', '--show-current'])
    || detachedBranchLabel(runner, root)
    || 'unknown';
  const baseBranch = gitText(runner, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    || options.baseBranch
    || 'main';
  const statusResult = runner(root, ['status', '--short']);
  const statusLines = splitLines(statusResult.stdout);
  const changedFiles = statusLines.map(statusFileName).filter(Boolean);
  const diffSummary = gitText(runner, root, ['diff', '--stat', '--', '.']);
  const unavailable = !gitText(runner, cwd, ['rev-parse', '--git-dir']);

  return defaultLaneState({
    ...options,
    worktree: root,
    branch,
    baseBranch,
    status: unavailable ? 'unavailable' : changedFiles.length > 0 ? 'dirty' : 'ready',
    changedFiles,
    diffSummary,
    verification: {
      command: verificationCommandFor(root),
      status: options.verification?.status ?? 'not run',
    },
    terminalLines: [
      '$ git status --short',
      ...(statusLines.length > 0 ? statusLines : ['clean']),
    ],
  });
}

export async function runLaneVerification(lane, options = {}) {
  const cwd = lane.worktree ?? process.cwd();
  const command = lane.verification?.command ?? verificationCommandFor(cwd);
  const runner = options.runner ?? runShell;
  const result = runner(command, cwd);
  return {
    ...lane,
    verification: {
      command,
      status: result.status === 0 ? 'passed' : 'failed',
    },
    terminalLines: [
      ...(lane.terminalLines ?? []).slice(-20),
      `$ ${command}`,
      ...splitLines(result.stdout),
      ...splitLines(result.stderr),
      `exit: ${result.status}`,
    ].slice(-40),
  };
}

export function normalizeLaneHarness(value) {
  return LANE_HARNESSES.includes(value) ? value : 'smart';
}

export function nextLaneHarness(current) {
  const index = LANE_HARNESSES.indexOf(normalizeLaneHarness(current));
  return LANE_HARNESSES[(index + 1) % LANE_HARNESSES.length];
}

function verificationCommandFor(cwd) {
  if (existsSync(path.join(cwd, 'package.json'))) return 'npm test';
  if (existsSync(path.join(cwd, 'Cargo.toml'))) return 'cargo test';
  return 'git diff --check';
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runShell(command, cwd) {
  const result = spawnSync(command, { cwd, encoding: 'utf8', shell: true });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function gitText(runner, cwd, args) {
  const result = runner(cwd, args);
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

function detachedBranchLabel(runner, cwd) {
  const sha = gitText(runner, cwd, ['rev-parse', '--short', 'HEAD']);
  return sha ? `detached:${sha}` : '';
}

function statusFileName(line) {
  const file = line.slice(3).trim();
  if (!file) return '';
  const rename = file.split(' -> ');
  return rename.at(-1) ?? file;
}

function splitLines(text = '') {
  return String(text).split(/\r?\n/).filter(Boolean);
}
