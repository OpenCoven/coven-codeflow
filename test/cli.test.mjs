import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  repoRoot,
  covenCodeBin,
  covenCodeSdkBin,
  makeWorkspace,
  runCovenCode,
  runCovenCodeSdk,
  runGit,
  escapeRegExp,
  expectAvailable,
} from './_helpers.mjs';

function trackedAndUntrackedTextFiles() {
  const tracked = runGit(['ls-files']).stdout.trim().split(/\r?\n/);
  const untracked = runGit(['ls-files', '--others', '--exclude-standard']).stdout.trim().split(/\r?\n/);
  return [...tracked, ...untracked].filter(Boolean);
}

test('repo identity drift audit has no legacy product markers', async () => {
  const oldLower = 'a' + 'mp';
  const oldTitle = 'A' + 'mp';
  const oldUpper = 'A' + 'MP';
  const oldAssistant = 'Cl' + 'aude';
  const oldVendor = 'Anth' + 'ropic';
  const oldVendorLower = oldVendor.toLowerCase();
  const forbidden = new RegExp([
    `@${oldLower}code`,
    `${oldLower}code\\.com`,
    `\\b${oldTitle}\\b`,
    `\\b${oldUpper}_[A-Z0-9_]+`,
    `\\.${oldLower}\\b`,
    `\\b${oldLower}\\.`,
    `\\b${oldLower}\\b`,
    `${oldAssistant}-compatible`,
    `${oldAssistant} Code`,
    `\\b${oldVendor}\\b`,
    `\\b${oldVendorLower}\\b`,
  ].join('|'));
  const files = trackedAndUntrackedTextFiles().filter((file) => {
    return file === 'README.md'
      || file === '.npmignore'
      || file === 'package.json'
      || file === 'package-lock.json'
      || file.startsWith('src/')
      || file.startsWith('bin/')
      || file.startsWith('test/')
      || (file.startsWith('docs/') && !file.startsWith('docs/superpowers/plans/'));
  });
  const offenders = [];
  for (const file of files) {
    const absolute = path.join(repoRoot, file);
    if (!existsSync(absolute)) continue;
    const text = await readFile(absolute, 'utf8');
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const match = forbidden.exec(line);
      if (match) offenders.push(`${file}:${index + 1}: ${match[0]}`);
    }
  }

  assert.deepEqual(offenders, []);
});

test('prints a Coven Code help screen with renamed binary', () => {
  const result = runCovenCode(['--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Coven Code/);
  assert.match(result.stdout, /Usage: coven-code/);
  assert.match(result.stdout, /--execute, -x/);
  assert.match(result.stdout, /tools/);
  assert.match(result.stdout, /permissions/);
  assert.match(result.stdout, /login/);
  assert.match(result.stdout, /Agent mode: smart, deep, rush, or large/);
  assert.match(result.stdout, /--reasoning-effort <level>/);
  const oldLower = 'a' + 'mp';
  const oldTitle = 'A' + 'mp';
  assert.doesNotMatch(result.stdout, new RegExp(`\\b${oldTitle}\\b|${oldLower}code|Usage:\\s+${oldLower}\\b`));
});

test('help lists documented noninteractive and config flags', () => {
  const result = runCovenCode(['--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--stream-json-input\s+Read one or more user messages as JSONL from stdin/);
  assert.match(result.stdout, /--settings-file <path>\s+Read user settings from a specific file/);
});

test('--mode accepts current Coven Code modes including non-recommended large mode', () => {
  const rush = runCovenCode(['--mode', 'rush', '--execute', 'what is 2+2?', '--stream-json']);
  assert.equal(rush.status, 0, rush.stderr);
  assert.equal(JSON.parse(rush.stdout.split('\n')[0]).agent_mode, 'rush');

  const large = runCovenCode(['--mode', 'large', '--execute', 'what is 2+2?', '--stream-json']);
  assert.equal(large.status, 0, large.stderr);
  assert.equal(JSON.parse(large.stdout.split('\n')[0]).agent_mode, 'large');
});

test('--reasoning-effort controls stream-json init within the active mode', () => {
  const smart = runCovenCode(['--mode', 'smart', '--reasoning-effort', 'max', '--execute', 'what is 2+2?', '--stream-json']);
  assert.equal(smart.status, 0, smart.stderr);
  assert.equal(JSON.parse(smart.stdout.split('\n')[0]).reasoning_effort, 'max');

  const deep = runCovenCode(['--mode', 'deep', '--reasoning-effort', 'medium', '--execute', 'what is 2+2?', '--stream-json']);
  assert.equal(deep.status, 0, deep.stderr);
  assert.equal(JSON.parse(deep.stdout.split('\n')[0]).reasoning_effort, 'medium');

  const rush = runCovenCode(['--mode', 'rush', '--reasoning-effort', 'max', '--execute', 'what is 2+2?']);
  assert.equal(rush.status, 2);
  assert.match(rush.stderr, /reasoning effort for rush must be one of: minimal/);
});

test('package metadata uses the Coven Code npm package and binaries', async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'));

  assert.equal(pkg.name, '@opencoven/coven-code');
  assert.equal(pkg.private, undefined);
  assert.deepEqual(pkg.bin, {
    'coven-code': 'bin/coven-code.mjs',
    'coven-code-sdk': 'bin/coven-code-sdk.mjs',
  });
  assert.equal(lock.name, '@opencoven/coven-code');
  assert.equal(lock.packages[''].name, '@opencoven/coven-code');
  assert.deepEqual(lock.packages[''].bin, {
    'coven-code': 'bin/coven-code.mjs',
    'coven-code-sdk': 'bin/coven-code-sdk.mjs',
  });
});

test('themes command is removed in the rebuilt CLI', async () => {
  const result = runCovenCode(['themes', 'list']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown command: themes/);
});

test(
  'piped stdin starts interactive mode when stdout is a TTY',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  () => {
    const script = [
      'log_user 1',
      'set timeout 10',
      `spawn -noecho sh -c {printf 'what is 2+2?\\n' | COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}}`,
      'expect {',
      '  -re "interactive mode" { }',
      '  eof { puts "EOF before interactive banner"; exit 2 }',
      '  timeout { puts "TIMEOUT waiting for interactive banner"; exit 3 }',
      '}',
      'expect {',
      '  -re "\\n4\\r?\\n" { }',
      '  eof { puts "EOF before seeded stdin result"; exit 4 }',
      '  timeout { puts "TIMEOUT waiting for seeded stdin result"; exit 5 }',
      '}',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /interactive mode/);
    assert.match(result.stdout, /\n4\r?\n/);
  },
);
