import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repoRoot = path.resolve(import.meta.dirname, '..');
const covenCodeBin = path.join(repoRoot, 'bin', 'coven-code.mjs');
const covenCodeSdkBin = path.join(repoRoot, 'bin', 'coven-code-sdk.mjs');

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'coven-code-recreate-'));
  await writeFile(path.join(dir, 'README.md'), '# Test Workspace\n');
  await writeFile(path.join(dir, 'AGENTS.md'), 'Use short answers.\n');
  await writeFile(path.join(dir, 'package.json'), '{"name":"fixture"}\n');
  return dir;
}

function runCovenCode(args, options = {}) {
  return spawnSync(process.execPath, [covenCodeBin, ...args], {
    cwd: options.cwd ?? repoRoot,
    input: options.input,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
  });
}

function runCovenCodeSdk(args, options = {}) {
  return spawnSync(process.execPath, [covenCodeSdkBin, ...args], {
    cwd: options.cwd ?? repoRoot,
    input: options.input,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
  });
}

function runGit(args, options = {}) {
  return spawnSync('git', args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function trackedAndUntrackedTextFiles() {
  const result = runGit(['ls-files', '--cached', '--others', '--exclude-standard']);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split(/\r?\n/).filter(Boolean).sort();
}

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
    'coven-code': './bin/coven-code.mjs',
    'coven-code-sdk': './bin/coven-code-sdk.mjs',
  });
  assert.equal(lock.name, '@opencoven/coven-code');
  assert.equal(lock.packages[''].name, '@opencoven/coven-code');
  assert.deepEqual(lock.packages[''].bin, {
    'coven-code': 'bin/coven-code.mjs',
    'coven-code-sdk': 'bin/coven-code-sdk.mjs',
  });
});

test('login stores COVEN_CODE_API_KEY locally and reports masked auth status', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const env = { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_API_KEY: 'ck_test_secret_abcdef' };

  const login = runCovenCode(['login'], { env });
  assert.equal(login.status, 0, login.stderr);
  assert.match(login.stdout, /Logged in with COVEN_CODE_API_KEY/);
  assert.doesNotMatch(login.stdout, /ck_test_secret_abcdef/);

  const authPath = path.join(xdg, 'coven-code', 'auth.json');
  assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), {
    accessToken: 'ck_test_secret_abcdef',
    source: 'COVEN_CODE_API_KEY',
  });

  const status = runCovenCode(['login', 'status'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_API_KEY: '' },
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /auth_status: logged_in/);
  assert.match(status.stdout, /token: ck_test_secre…cdef/);
  assert.doesNotMatch(status.stdout, /ck_test_secret_abcdef/);
});

test('login stores COVEN_CODE_API_KEY under coven-code config paths', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const env = { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_API_KEY: 'ck_test_secret_123456' };

  const login = runCovenCode(['login'], { env });
  assert.equal(login.status, 0, login.stderr);
  assert.match(login.stdout, /Logged in with COVEN_CODE_API_KEY/);
  assert.doesNotMatch(login.stdout, /ck_test_secret_123456/);

  const authPath = path.join(xdg, 'coven-code', 'auth.json');
  assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), {
    accessToken: 'ck_test_secret_123456',
    source: 'COVEN_CODE_API_KEY',
  });

  const status = runCovenCode(['login', 'status'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_API_KEY: '' },
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /auth_status: logged_in/);
  assert.match(status.stdout, /source: COVEN_CODE_API_KEY/);
  assert.match(status.stdout, /token: ck_test_secre…3456/);
  assert.doesNotMatch(status.stdout, /ck_test_secret_123456/);
});

test('--jetbrains reports local IDE integration detection status', () => {
  const result = runCovenCode(['--jetbrains']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ide: jetbrains/);
  assert.match(result.stdout, /status: unavailable \(local recreation\)/);
  assert.match(result.stdout, /hint: run Coven Code from the JetBrains terminal or install the Coven Code IDE plugin/);
});

test('ide connect command reports local IDE integration detection status', () => {
  const result = runCovenCode(['ide', 'connect']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ide: auto/);
  assert.match(result.stdout, /status: unavailable \(local recreation\)/);
  assert.match(result.stdout, /hint: run Coven Code from a supported IDE terminal or install the Coven Code IDE plugin/);
});

test('execute mode answers a prompt and can inspect markdown files in cwd', async () => {
  const cwd = await makeWorkspace();

  const result = runCovenCode(['-x', 'what files in this folder are markdown files? Print only the filenames.'], { cwd });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'AGENTS.md\nREADME.md');
});

test('execute mode combines stdin with a prompt', async () => {
  const result = runCovenCode(['--execute', 'which colorscheme is used?'], {
    input: 'set background=dark\ncolorscheme gruvbox\n',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /gruvbox/);
});

test('COVEN_CODE_FORCE_BEL emits completion bell unless notifications are disabled', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const enabled = runCovenCode(['--execute', 'what is 2+2?'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_FORCE_BEL: '1' },
  });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(enabled.stdout.trim(), '4');
  assert.equal(enabled.stderr, '\x07');

  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.notifications.enabled': false,
  }));

  const disabled = runCovenCode(['--execute', 'what is 2+2?'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_FORCE_BEL: '1' },
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(disabled.stdout.trim(), '4');
  assert.equal(disabled.stderr, '');
});

test('review reports configured checks with closer project overrides', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const apiDir = path.join(workspace, 'api');
  await mkdir(path.join(xdg, 'coven-code', 'checks'), { recursive: true });
  await mkdir(path.join(workspace, '.agents', 'checks'), { recursive: true });
  await mkdir(path.join(apiDir, '.agents', 'checks'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'checks', 'security.md'), `---
name: security
description: Global security check
severity-default: low
tools: [Read]
---

Global security guidance.
`);
  await writeFile(path.join(workspace, '.agents', 'checks', 'security.md'), `---
name: security
description: Root security check
severity-default: medium
tools: [Grep]
---

Root security guidance.
`);
  await writeFile(path.join(workspace, '.agents', 'checks', 'performance.md'), `---
name: performance
description: Performance footguns
severity-default: medium
tools: [Grep, Read]
---

Look for avoidable repeated work.
`);
  await writeFile(path.join(apiDir, '.agents', 'checks', 'security.md'), `---
name: security
description: API security check
severity-default: high
tools: [Read]
---

API security guidance.
`);

  const result = runCovenCode(['review'], {
    cwd: apiDir,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Review jobs:/);
  assert.match(result.stdout, /security\s+passed\s+high\s+Read\s+api\/\.agents\/checks\/security\.md\s+API security check/);
  assert.match(result.stdout, /performance\s+passed\s+medium\s+Grep, Read\s+\.agents\/checks\/performance\.md\s+Performance footguns/);
  assert.doesNotMatch(result.stdout, /Root security check/);
  assert.doesNotMatch(result.stdout, /Global security check/);
  assert.doesNotMatch(result.stdout, /stub/i);
  assert.match(result.stdout, /No review findings from configured local checks\./);
});

test('execute mode expands @file mentions from relative, absolute, and home paths', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const cwd = await makeWorkspace();
  await mkdir(path.join(cwd, 'docs'), { recursive: true });
  await writeFile(path.join(cwd, 'docs', 'plan.md'), '# Launch Plan\ncodename: ember-maple\n');
  await writeFile(path.join(cwd, 'Makefile'), 'codename: build-cedar\n');
  await writeFile(path.join(home, 'personal.md'), '# Personal Notes\ncodename: home-signal\n');

  const relative = runCovenCode(['--execute', 'what codename is in @docs/plan.md?'], {
    cwd,
    env: { HOME: home },
  });
  assert.equal(relative.status, 0, relative.stderr);
  assert.match(relative.stdout, /ember-maple/);

  const absolute = runCovenCode(['--execute', `what codename is in @${path.join(cwd, 'docs', 'plan.md')}?`], {
    cwd,
    env: { HOME: home },
  });
  assert.equal(absolute.status, 0, absolute.stderr);
  assert.match(absolute.stdout, /ember-maple/);

  const extensionless = runCovenCode(['--execute', 'what codename is in @Makefile?'], {
    cwd,
    env: { HOME: home },
  });
  assert.equal(extensionless.status, 0, extensionless.stderr);
  assert.match(extensionless.stdout, /build-cedar/);

  const homeMention = runCovenCode(['--execute', 'what codename is in @~/personal.md?'], {
    cwd,
    env: { HOME: home },
  });
  assert.equal(homeMention.status, 0, homeMention.stderr);
  assert.match(homeMention.stdout, /home-signal/);
});

test('execute mode expands glob @file mentions in sorted order', async () => {
  const cwd = await makeWorkspace();
  await mkdir(path.join(cwd, 'docs'), { recursive: true });
  await writeFile(path.join(cwd, 'docs', 'beta.md'), '# Beta\ncodename: river-bell\n');
  await writeFile(path.join(cwd, 'docs', 'alpha.md'), '# Alpha\ncodename: amber-fern\n');
  await writeFile(path.join(cwd, 'docs', 'ignore.txt'), 'codename: plain-text\n');

  const result = runCovenCode(['--execute', 'list the codenames in @docs/*.md'], { cwd });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'amber-fern\nriver-bell');
});

test('covenCode.fuzzy.alwaysIncludePaths includes gitignored files in glob @file mentions', async () => {
  const cwd = await makeWorkspace();
  await mkdir(path.join(cwd, 'src'), { recursive: true });
  await mkdir(path.join(cwd, 'dist'), { recursive: true });
  await mkdir(path.join(cwd, '.coven-code'), { recursive: true });
  await writeFile(path.join(cwd, '.gitignore'), 'dist/\n');
  await writeFile(path.join(cwd, 'src', 'visible.md'), 'codename: visible-fern\n');
  await writeFile(path.join(cwd, 'dist', 'generated.md'), 'codename: generated-river\n');

  const hidden = runCovenCode(['--execute', 'list the codenames in @**/*.md'], { cwd });
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.equal(hidden.stdout.trim(), 'visible-fern');

  await writeFile(path.join(cwd, '.coven-code', 'settings.json'), JSON.stringify({
    'covenCode.fuzzy.alwaysIncludePaths': ['dist/**'],
  }));

  const included = runCovenCode(['--execute', 'list the codenames in @**/*.md'], { cwd });
  assert.equal(included.status, 0, included.stderr);
  assert.equal(included.stdout.trim(), 'generated-river\nvisible-fern');
});

test('--settings-file applies covenCode.fuzzy.alwaysIncludePaths to glob @file mentions', async () => {
  const cwd = await makeWorkspace();
  const settingsFile = path.join(cwd, 'custom-settings.json');
  await mkdir(path.join(cwd, 'src'), { recursive: true });
  await mkdir(path.join(cwd, 'dist'), { recursive: true });
  await writeFile(path.join(cwd, '.gitignore'), 'dist/\n');
  await writeFile(path.join(cwd, 'src', 'visible.md'), 'codename: visible-lake\n');
  await writeFile(path.join(cwd, 'dist', 'generated.md'), 'codename: generated-sky\n');
  await writeFile(settingsFile, JSON.stringify({
    'covenCode.fuzzy.alwaysIncludePaths': ['dist/**'],
  }));

  const result = runCovenCode(['--settings-file', settingsFile, '--execute', 'list the codenames in @**/*.md'], { cwd });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'generated-sky\nvisible-lake');
});

test('execute mode truncates text @file mentions and ignores binary files', async () => {
  const cwd = await makeWorkspace();
  await mkdir(path.join(cwd, 'docs'), { recursive: true });
  const longLines = Array.from({ length: 501 }, (_, index) => (
    index === 500 ? 'codename: hidden-after-limit' : `line-${String(index + 1).padStart(3, '0')} ${'x'.repeat(2100)}`
  ));
  await writeFile(path.join(cwd, 'docs', 'long.md'), `${longLines.join('\n')}\n`);
  await writeFile(path.join(cwd, 'docs', 'binary.bin'), Buffer.from([0x63, 0x6f, 0x64, 0x65, 0x6e, 0x61, 0x6d, 0x65, 0x3a, 0x20, 0x62, 0x69, 0x6e, 0x61, 0x72, 0x79, 0x2d, 0x73, 0x65, 0x63, 0x72, 0x65, 0x74, 0x00]));

  const longResult = runCovenCode(['--execute', 'what codename is in @docs/long.md?'], { cwd });
  assert.equal(longResult.status, 0, longResult.stderr);
  assert.match(longResult.stdout, /No codename was found/);

  const binaryResult = runCovenCode(['--execute', 'what codename is in @docs/binary.bin?'], { cwd });
  assert.equal(binaryResult.status, 0, binaryResult.stderr);
  assert.match(binaryResult.stdout, /No codename was found/);
});

test('execute mode expands @image mentions with media metadata', async () => {
  const cwd = await makeWorkspace();
  await mkdir(path.join(cwd, 'images'), { recursive: true });
  await writeFile(path.join(cwd, 'images', 'sample.png'), Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]));

  const result = runCovenCode(['--execute', 'what image file is mentioned in @images/sample.png?'], { cwd });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'sample.png image/png 12 bytes');
});

test('stream json emits init, user, assistant, and result messages', async () => {
  const cwd = await makeWorkspace();

  const result = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], { cwd });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.type), ['system', 'user', 'assistant', 'result']);
  assert.equal(messages[0].subtype, 'init');
  assert.equal(messages[0].cwd, cwd);
  assert.ok(messages[0].session_id.startsWith('T-'));
  assert.ok(!messages[0].tools.includes('todo_read'));
  assert.ok(!messages[0].tools.includes('todo_write'));
  assert.equal(messages[2].message.content[0].text, '4');
  assert.equal(messages[3].result, '4');
});

test('stream json emits appendix-compatible error result when tool execution fails', async () => {
  const cwd = await makeWorkspace();

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use Bash --command "printf stream-json-boom; exit 7"',
    '--stream-json',
  ], { cwd });

  assert.equal(result.status, 7, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const toolResult = messages.find((message) => message.type === 'user' && message.message.content[0]?.type === 'tool_result');
  assert.equal(toolResult.message.content[0].is_error, true);
  assert.equal(toolResult.message.content[0].content, 'stream-json-boom');
  const final = messages.at(-1);
  assert.equal(final.type, 'result');
  assert.equal(final.subtype, 'error_during_execution');
  assert.equal(final.is_error, true);
  assert.equal(final.num_turns, 2);
  assert.equal(final.error, 'stream-json-boom');
  assert.equal(Object.hasOwn(final, 'result'), false);
});

test('stream json handles early downstream pipe close without a stack trace', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const command = [
    'set -o pipefail',
    `for i in $(seq 1 200); do printf '%s\\n' ${JSON.stringify('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"what is 2+2?"}]}}')}; done | ${JSON.stringify(process.execPath)} ${JSON.stringify(covenCodeBin)} --execute --stream-json --stream-json-input | head -n 1 >/dev/null`,
  ].join('; ');

  const result = spawnSync('bash', ['-lc', command], {
    cwd: repoRoot,
    env: { ...process.env, XDG_CONFIG_HOME: path.join(home, '.config'), HOME: home },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('stream json flags enforce documented dependencies', async () => {
  const thinking = runCovenCode(['--execute', 'what is 2+2?', '--stream-json-thinking']);
  assert.equal(thinking.status, 0, thinking.stderr);
  assert.doesNotThrow(() => JSON.parse(thinking.stdout.split('\n')[0]));

  const inputWithoutStream = runCovenCode(['--execute', '--stream-json-input'], {
    input: '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"what is 2+2?"}]}}\n',
  });
  assert.equal(inputWithoutStream.status, 2);
  assert.match(inputWithoutStream.stderr, /--stream-json-input requires --stream-json/);

  const inputWithoutExecute = runCovenCode(['--stream-json', '--stream-json-input'], {
    input: '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"what is 2+2?"}]}}\n',
  });
  assert.equal(inputWithoutExecute.status, 2);
  assert.match(inputWithoutExecute.stderr, /--stream-json requires --execute/);
});

test('covenCode.thinking.enabled false suppresses stream-json thinking blocks', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.thinking.enabled': false,
  }));

  const result = runCovenCode(['--execute', 'what is 2+2?', '--stream-json-thinking'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const assistant = messages.find((message) => message.type === 'assistant');
  assert.deepEqual(assistant.message.content, [{ type: 'text', text: '4' }]);
});

test('stream json input accepts image content blocks from file URLs', async () => {
  const cwd = await makeWorkspace();
  await mkdir(path.join(cwd, 'images'), { recursive: true });
  const imagePath = path.join(cwd, 'images', 'sample.png');
  await writeFile(imagePath, Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]));
  const input = `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'what image file is included?' },
        { type: 'image', source_path: pathToFileURL(imagePath).href },
      ],
    },
  })}\n`;

  const result = runCovenCode(['--execute', '--stream-json', '--stream-json-input'], { cwd, input });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(messages[1].message.content, [{ type: 'text', text: 'what image file is included?' }]);
  assert.equal(messages.at(-1).result, 'sample.png image/png 12 bytes');
});

test('stream json input accepts base64 image content blocks without source paths', async () => {
  const cwd = await makeWorkspace();
  const input = `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'what image file is included?' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: Buffer.from([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
              0x00, 0x00, 0x00, 0x0d,
            ]).toString('base64'),
          },
        },
      ],
    },
  })}\n`;

  const result = runCovenCode(['--execute', '--stream-json', '--stream-json-input'], { cwd, input });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(messages.at(-1).result, 'stream-json-input-image-1.png image/png 12 bytes');
});

test('stream json input rejects base64 image blocks with mismatched media types', async () => {
  const cwd = await makeWorkspace();
  const input = `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'what image file is included?' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: Buffer.from([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
              0x00, 0x00, 0x00, 0x0d,
            ]).toString('base64'),
          },
        },
      ],
    },
  })}\n`;

  const result = runCovenCode(['--execute', '--stream-json', '--stream-json-input'], { cwd, input });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /coven-code: stream-json-input image media_type image\/jpeg does not match decoded image\/png/);
});

test('stream json input reports malformed JSONL as a usage error', async () => {
  const result = runCovenCode(['--execute', '--stream-json', '--stream-json-input'], {
    input: '{"type":"user","message":\n',
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /coven-code: stream-json-input line 1 is not valid JSON/);
  assert.doesNotMatch(result.stderr, /SyntaxError|at JSON\.parse/);
});

test('stream json input validates base64 image source when source_path is also present', async () => {
  const cwd = await makeWorkspace();
  await mkdir(path.join(cwd, 'images'), { recursive: true });
  const imagePath = path.join(cwd, 'images', 'sample.png');
  await writeFile(imagePath, Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]));
  const input = `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'what image file is included?' },
        {
          type: 'image',
          source_path: pathToFileURL(imagePath).href,
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: Buffer.from([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
              0x00, 0x00, 0x00, 0x0d,
            ]).toString('base64'),
          },
        },
      ],
    },
  })}\n`;

  const result = runCovenCode(['--execute', '--stream-json', '--stream-json-input'], { cwd, input });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /coven-code: stream-json-input image media_type image\/jpeg does not match decoded image\/png/);
});

test('stream json input handles multiple user messages as one conversation', async () => {
  const cwd = await makeWorkspace();
  const input = [
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'what is 2+2?' }],
      },
    },
    {
      type: 'user',
      steer: true,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'now add 8 to that' }],
      },
    },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';

  const result = runCovenCode(['--execute', '--stream-json', '--stream-json-input'], { cwd, input });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.type), [
    'system',
    'user',
    'assistant',
    'user',
    'assistant',
    'result',
  ]);
  assert.equal(messages[3].steer, true);
  assert.equal(messages[4].message.content[0].text, '12');
  assert.equal(messages[5].num_turns, 2);
  assert.equal(messages[5].result, '12');
});

test('covenCode.tools.disable filters builtin and toolbox tools in lists and stream json', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const toolsDir = path.join(home, 'tools');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(toolsDir, { recursive: true });
  await writeFile(path.join(toolsDir, 'secret_lookup'), `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({ name: 'secret_lookup', description: 'Hidden lookup tool' }));
}
`);
  await writeFile(path.join(toolsDir, 'public_lookup'), `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({ name: 'public_lookup', description: 'Visible lookup tool' }));
}
`);
  await chmod(path.join(toolsDir, 'secret_lookup'), 0o755);
  await chmod(path.join(toolsDir, 'public_lookup'), 0o755);
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.tools.disable': ['builtin:Bash', 'tb__secret*'],
  }));

  const list = runCovenCode(['tools', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_TOOLBOX: toolsDir },
  });
  assert.equal(list.status, 0, list.stderr);
  assert.doesNotMatch(list.stdout, /^Bash\s+built-in/m);
  assert.match(list.stdout, /Read\s+built-in/);
  assert.doesNotMatch(list.stdout, /tb__secret_lookup/);
  assert.match(list.stdout, /tb__public_lookup\s+toolbox\s+Visible lookup tool/);

  const stream = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_TOOLBOX: toolsDir },
  });
  assert.equal(stream.status, 0, stream.stderr);
  const init = JSON.parse(stream.stdout.split('\n')[0]);
  assert.ok(!init.tools.includes('Bash'));
  assert.ok(init.tools.includes('Read'));
  assert.ok(!init.tools.includes('tb__secret_lookup'));
  assert.ok(init.tools.includes('tb__public_lookup'));
});

test('covenCode.tools.disable honors --settings-file in tool lists and stream json', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const settingsFile = path.join(home, 'custom-settings.json');
  await writeFile(settingsFile, JSON.stringify({
    'covenCode.tools.disable': ['builtin:Bash'],
  }));

  const list = runCovenCode(['--settings-file', settingsFile, 'tools', 'list'], {
    env: { HOME: home },
  });
  assert.equal(list.status, 0, list.stderr);
  assert.doesNotMatch(list.stdout, /^Bash\s+built-in/m);
  assert.match(list.stdout, /Read\s+built-in/);

  const stream = runCovenCode(['--settings-file', settingsFile, '--execute', 'what is 2+2?', '--stream-json'], {
    env: { HOME: home },
  });
  assert.equal(stream.status, 0, stream.stderr);
  const init = JSON.parse(stream.stdout.split('\n')[0]);
  assert.ok(!init.tools.includes('Bash'));
  assert.ok(init.tools.includes('Read'));
});

test('workspace covenCode.tools.disable overrides user settings in tool lists and stream json', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.tools.disable': ['builtin:Bash'],
  }));
  await writeFile(path.join(workspace, '.coven-code', 'settings.json'), JSON.stringify({
    'covenCode.tools.disable': ['builtin:Read'],
  }));

  const list = runCovenCode(['tools', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^Bash\s+built-in/m);
  assert.doesNotMatch(list.stdout, /^Read\s+built-in/m);

  const stream = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(stream.status, 0, stream.stderr);
  const init = JSON.parse(stream.stdout.split('\n')[0]);
  assert.ok(init.tools.includes('Bash'));
  assert.ok(!init.tools.includes('Read'));
});

test('workspace settings search stops at the current repository root', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const parent = path.join(home, 'parent');
  const repo = path.join(parent, 'repo');
  const app = path.join(repo, 'app');
  await mkdir(path.join(parent, '.coven-code'), { recursive: true });
  await mkdir(path.join(repo, '.git'), { recursive: true });
  await mkdir(app, { recursive: true });
  await writeFile(path.join(parent, '.coven-code', 'settings.json'), JSON.stringify({
    'covenCode.tools.disable': ['builtin:Bash'],
  }));
  await writeFile(path.join(repo, 'package.json'), '{"name":"repo"}\n');

  const result = runCovenCode(['tools', 'list'], {
    cwd: app,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Bash\s+built-in/m);
});

test('managed settings override user and workspace settings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const managedSettings = path.join(home, 'managed-settings.json');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.tools.disable': ['builtin:Bash'],
    'covenCode.permissions': [
      { action: 'allow', tool: 'Bash', matches: { cmd: 'npm test*' } },
    ],
  }));
  await writeFile(path.join(workspace, '.coven-code', 'settings.json'), JSON.stringify({
    'covenCode.tools.disable': ['builtin:Read'],
    'covenCode.permissions': [
      { action: 'allow', tool: 'Bash', matches: { cmd: 'npm test*' } },
    ],
  }));
  await writeFile(managedSettings, JSON.stringify({
    'covenCode.tools.disable': ['builtin:create_file'],
    'covenCode.permissions': [
      { action: 'reject', tool: 'Bash', matches: { cmd: 'npm test*' } },
    ],
    'covenCode.admin.compatibilityDate': '2026-05-24',
  }));

  const tools = runCovenCode(['tools', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_MANAGED_SETTINGS_FILE: managedSettings },
  });
  assert.equal(tools.status, 0, tools.stderr);
  assert.match(tools.stdout, /^Bash\s+built-in/m);
  assert.match(tools.stdout, /^Read\s+built-in/m);
  assert.doesNotMatch(tools.stdout, /^create_file\s+built-in/m);

  const decision = runCovenCode(['permissions', 'test', 'Bash', '--cmd', 'npm test -- --runInBand'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_MANAGED_SETTINGS_FILE: managedSettings },
  });
  assert.equal(decision.status, 0, decision.stderr);
  assert.match(decision.stdout, /action: reject/);
});

test('settings.jsonc accepts comments, URLs, and trailing commas', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.jsonc'), `{
  // Built-in tools can be disabled from JSONC settings.
  "covenCode.tools.disable": [
    "builtin:Bash",
  ],
  /*
   * Remote MCP server URLs should survive comment stripping.
   */
  "covenCode.mcpServers": {
    "remote": { "url": "https://mcp.example.com/sse" },
  },
}
`);

  const tools = runCovenCode(['tools', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(tools.status, 0, tools.stderr);
  assert.doesNotMatch(tools.stdout, /^Bash\s+built-in/m);
  assert.match(tools.stdout, /^Read\s+built-in/m);

  const mcp = runCovenCode(['mcp', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.match(mcp.stdout, /remote\s+user\s+approved\s+https:\/\/mcp\.example\.com\/sse/);
});

test('permissions list --builtin prints default shell policy rules', () => {
  const result = runCovenCode(['permissions', 'list', '--builtin']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /allow Bash --cmd 'git status\*'/);
  assert.match(result.stdout, /ask Bash --cmd 'rm -rf\*'/);
});

test('execute mode allows tool calls by default when legacy permissions are not configured', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const result = runCovenCode(['--execute', 'use Bash --command "printf default-allowed"'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'default-allowed');
});

test('permissions add and test evaluate user rules before builtin rules', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const addResult = runCovenCode(['permissions', 'add', 'reject', 'Bash', '--cmd', '*terraform*apply*'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(addResult.status, 0, addResult.stderr);
  assert.match(addResult.stdout, /Added permission rule/);

  const testResult = runCovenCode(['permissions', 'test', 'Bash', '--cmd', 'terraform apply -auto-approve'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(testResult.status, 0, testResult.stderr);
  assert.match(testResult.stdout, /tool: Bash/);
  assert.match(testResult.stdout, /action: reject/);
  assert.match(testResult.stdout, /matched-rule: 0/);
  assert.match(testResult.stdout, /source: user/);

  const builtinResult = runCovenCode(['permissions', 'test', 'Bash', '--cmd', 'git status --short'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(builtinResult.status, 0, builtinResult.stderr);
  assert.match(builtinResult.stdout, /action: allow/);
  assert.match(builtinResult.stdout, /matched-rule: \d+/);
  assert.match(builtinResult.stdout, /source: built-in/);
});

test('permissions edit replaces user rules from stdin text format', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const editResult = runCovenCode(['permissions', 'edit'], {
    input: "ask Bash --cmd '*'\nallow Read --path 'README.md'\n",
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(editResult.status, 0, editResult.stderr);

  const listResult = runCovenCode(['permissions', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /ask Bash --cmd '\*'/);
  assert.match(listResult.stdout, /allow Read --path README.md/);
});

test('permissions list output round-trips through text edit format', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const editResult = runCovenCode(['permissions', 'edit'], {
    input: [
      "reject --message 'No deploys from this fixture' Bash --cmd 'deploy *'",
      "delegate --to coven-code-gh-permission-helper Bash --cmd 'gh *'",
      "allow --context subagent edit_file --patch.mode replace",
      '',
    ].join('\n'),
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(editResult.status, 0, editResult.stderr);

  const listResult = runCovenCode(['permissions', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /reject --message 'No deploys from this fixture' Bash --cmd 'deploy \*'/);
  assert.match(listResult.stdout, /delegate --to coven-code-gh-permission-helper Bash --cmd 'gh \*'/);
  assert.match(listResult.stdout, /allow --context subagent edit_file --patch.mode replace/);

  const reeditResult = runCovenCode(['permissions', 'edit'], {
    input: listResult.stdout,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(reeditResult.status, 0, reeditResult.stderr);

  const delegated = runCovenCode(['permissions', 'test', 'Bash', '--cmd', 'gh pr view 123'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(delegated.status, 0, delegated.stderr);
  assert.match(delegated.stdout, /action: delegate/);
  assert.match(delegated.stdout, /to: coven-code-gh-permission-helper/);

  const subagent = runCovenCode(['permissions', 'test', 'edit_file', '--context', 'subagent', '--patch.mode', 'replace'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(subagent.status, 0, subagent.stderr);
  assert.match(subagent.stdout, /action: allow/);
});

test('permissions text format supports undefined literal match conditions', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const editResult = runCovenCode(['permissions', 'edit'], {
    input: [
      'allow web_search --query undefined',
      "reject web_search --query '*'",
      '',
    ].join('\n'),
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(editResult.status, 0, editResult.stderr);

  const listResult = runCovenCode(['permissions', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /allow web_search --query undefined/);

  const missingQuery = runCovenCode(['permissions', 'test', 'web_search'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(missingQuery.status, 0, missingQuery.stderr);
  assert.match(missingQuery.stdout, /action: allow/);
  assert.match(missingQuery.stdout, /matched-rule: 0/);

  const presentQuery = runCovenCode(['permissions', 'test', 'web_search', '--query', 'node'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(presentQuery.status, 0, presentQuery.stderr);
  assert.match(presentQuery.stdout, /action: reject/);
  assert.match(presentQuery.stdout, /matched-rule: 1/);
});

test('permissions test supports regex, literal, and nested object match conditions', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.permissions': [
      { action: 'allow', tool: 'Bash', matches: { cmd: '/^git (status|log|diff)$/' } },
      { action: 'ask', tool: 'web_search', matches: { safe: true } },
      { action: 'reject', tool: 'edit_file', matches: { patch: { mode: 'replace' } } },
    ],
  }));

  const regexMatch = runCovenCode(['permissions', 'test', 'Bash', '--cmd', 'git status'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(regexMatch.status, 0, regexMatch.stderr);
  assert.match(regexMatch.stdout, /action: allow/);
  assert.match(regexMatch.stdout, /matched-rule: 0/);

  const regexMiss = runCovenCode(['permissions', 'test', 'Bash', '--cmd', 'git commit'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(regexMiss.status, 0, regexMiss.stderr);
  assert.doesNotMatch(regexMiss.stdout, /matched-rule: 0/);

  const literalMatch = runCovenCode(['permissions', 'test', 'web_search', '--safe', 'true'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(literalMatch.status, 0, literalMatch.stderr);
  assert.match(literalMatch.stdout, /action: ask/);
  assert.match(literalMatch.stdout, /matched-rule: 1/);

  const nestedMatch = runCovenCode(['permissions', 'test', 'edit_file', '--patch.mode', 'replace'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(nestedMatch.status, 0, nestedMatch.stderr);
  assert.match(nestedMatch.stdout, /action: reject/);
  assert.match(nestedMatch.stdout, /matched-rule: 2/);
});

test('execute mode surfaces custom reject permission messages', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.permissions': [
      {
        action: 'reject',
        tool: 'Bash',
        matches: { cmd: 'git checkout *' },
        message: 'Do not use git checkout. Use edit_file instead.',
      },
    ],
  }));

  const result = runCovenCode([
    '--execute',
    'use Bash --command "git checkout main"',
    '--stream-json',
  ], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const final = result.stdout.trim().split('\n').map((line) => JSON.parse(line)).at(-1);
  assert.equal(final.result, 'Permission denied for Bash: Do not use git checkout. Use edit_file instead.');
  assert.deepEqual(final.permission_denials, [
    'Bash: reject (permission)',
  ]);
});

test('permissions edit parses action args and test respects context restrictions', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const editResult = runCovenCode(['permissions', 'edit'], {
    input: [
      "allow --context thread Bash --cmd 'git status*'",
      "reject --context subagent Bash --cmd 'git status*'",
      "delegate --to coven-code-gh-permission-helper Bash --cmd 'gh *'",
      '',
    ].join('\n'),
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(editResult.status, 0, editResult.stderr);

  const thread = runCovenCode(['permissions', 'test', 'Bash', '--context', 'thread', '--cmd', 'git status --short'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(thread.status, 0, thread.stderr);
  assert.match(thread.stdout, /action: allow/);
  assert.match(thread.stdout, /matched-rule: 0/);

  const subagent = runCovenCode(['permissions', 'test', 'Bash', '--context', 'subagent', '--cmd', 'git status --short'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(subagent.status, 0, subagent.stderr);
  assert.match(subagent.stdout, /action: reject/);
  assert.match(subagent.stdout, /matched-rule: 1/);

  const delegated = runCovenCode(['permissions', 'test', 'Bash', '--cmd', 'gh pr view 123'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(delegated.status, 0, delegated.stderr);
  assert.match(delegated.stdout, /action: delegate/);
  assert.match(delegated.stdout, /to: coven-code-gh-permission-helper/);
  assert.match(delegated.stdout, /matched-rule: 2/);
});

test('covenCode.commands.allowlist allows matching Bash command names', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.commands.allowlist': ['node'],
  }));

  const allowed = runCovenCode(['permissions', 'test', 'Bash', '--cmd', 'node --version'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /action: allow/);
  assert.match(allowed.stdout, /source: command-allowlist/);

  const blocked = runCovenCode(['permissions', 'test', 'Bash', '--cmd', 'python --version'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.match(blocked.stdout, /action: reject/);

  const executed = runCovenCode(['--execute', 'use Bash --command "node --version"'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(executed.status, 0, executed.stderr);
  assert.match(executed.stdout.trim(), /^v\d+\./);
});

test('workspace covenCode.permissions overrides user settings for list and test', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.permissions': [
      { action: 'reject', tool: 'Bash', matches: { cmd: 'npm test*' } },
    ],
  }));
  await writeFile(path.join(workspace, '.coven-code', 'settings.json'), JSON.stringify({
    'covenCode.permissions': [
      { action: 'allow', tool: 'Bash', matches: { cmd: 'npm test*' } },
    ],
  }));

  const list = runCovenCode(['permissions', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /allow Bash --cmd 'npm test\*'/);
  assert.doesNotMatch(list.stdout, /reject Bash --cmd 'npm test\*'/);

  const decision = runCovenCode(['permissions', 'test', 'Bash', '--cmd', 'npm test -- --runInBand'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(decision.status, 0, decision.stderr);
  assert.match(decision.stdout, /action: allow/);
});

test('config edit opens the user settings file in EDITOR', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const editorScript = path.join(home, 'editor.mjs');
  const marker = path.join(home, 'opened.txt');
  await writeFile(editorScript, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.COVEN_CODE_TEST_MARKER, process.argv[2]);
writeFileSync(process.argv[2], JSON.stringify({ 'covenCode.showCosts': false }, null, 2) + '\\n');
`);

  const result = runCovenCode(['config', 'edit'], {
    env: {
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      EDITOR: `${process.execPath} ${editorScript}`,
      COVEN_CODE_TEST_MARKER: marker,
    },
  });

  const settingsPath = path.join(xdg, 'coven-code', 'settings.json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(marker, 'utf8'), settingsPath);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { 'covenCode.showCosts': false });
});

test('config edit --workspace opens the workspace settings file in EDITOR', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const workspace = await makeWorkspace();
  const editorScript = path.join(home, 'editor.mjs');
  const marker = path.join(home, 'opened.txt');
  await writeFile(editorScript, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.COVEN_CODE_TEST_MARKER, process.argv[2]);
writeFileSync(process.argv[2], JSON.stringify({ 'covenCode.tools.disable': ['builtin:Bash'] }, null, 2) + '\\n');
`);

  const result = runCovenCode(['config', 'edit', '--workspace'], {
    cwd: workspace,
    env: {
      HOME: home,
      EDITOR: `${process.execPath} ${editorScript}`,
      COVEN_CODE_TEST_MARKER: marker,
    },
  });

  const settingsPath = path.join(workspace, '.coven-code', 'settings.json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readFile(marker, 'utf8')).replace(/^\/private\/var\//, '/var/'), settingsPath);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { 'covenCode.tools.disable': ['builtin:Bash'] });
});

test('config edit --workspace opens an existing workspace settings.jsonc file', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const workspace = await makeWorkspace();
  const editorScript = path.join(home, 'editor.mjs');
  const marker = path.join(home, 'opened.txt');
  const settingsPath = path.join(workspace, '.coven-code', 'settings.jsonc');
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, '{\n  // keep jsonc\n  "covenCode.showCosts": true,\n}\n');
  await writeFile(editorScript, `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.COVEN_CODE_TEST_MARKER, process.argv[2]);
`);

  const result = runCovenCode(['config', 'edit', '--workspace'], {
    cwd: workspace,
    env: {
      HOME: home,
      EDITOR: `${process.execPath} ${editorScript}`,
      COVEN_CODE_TEST_MARKER: marker,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readFile(marker, 'utf8')).replace(/^\/private\/var\//, '/var/'), settingsPath);
});

test('update respects skip env and covenCode.updates.mode settings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.updates.mode': 'disabled',
  }));
  await writeFile(path.join(workspace, '.coven-code', 'settings.json'), JSON.stringify({
    'covenCode.updates.mode': 'warn',
  }));

  const skipped = runCovenCode(['update'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(skipped.stdout, /update_check: skipped/);
  assert.match(skipped.stdout, /reason: COVEN_CODE_SKIP_UPDATE_CHECK=1/);
  assert.match(skipped.stdout, /update_action: none/);

  const disabled = runCovenCode(['update'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /update_check: disabled/);
  assert.match(disabled.stdout, /mode: disabled/);
  assert.match(disabled.stdout, /update_action: none/);

  const warn = runCovenCode(['update'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(warn.status, 0, warn.stderr);
  assert.match(warn.stdout, /update_check: checked/);
  assert.match(warn.stdout, /mode: warn/);
  assert.match(warn.stdout, /update_action: notify/);

  const autoHome = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const auto = runCovenCode(['update'], {
    env: { XDG_CONFIG_HOME: path.join(autoHome, '.config'), HOME: autoHome },
  });
  assert.equal(auto.status, 0, auto.stderr);
  assert.match(auto.stdout, /update_check: checked/);
  assert.match(auto.stdout, /mode: auto/);
  assert.match(auto.stdout, /update_action: auto/);
});

test('themes command is removed in the rebuilt CLI', async () => {
  const result = runCovenCode(['themes', 'list']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown command: themes/);
});

test('tools make creates a toolbox tool and tools list discovers it', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  await mkdir(xdg, { recursive: true });

  const makeResult = runCovenCode(['tools', 'make', '--bash', 'run_tests'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(makeResult.status, 0, makeResult.stderr);
  assert.match(makeResult.stdout, /Tool created at:/);

  const toolPath = makeResult.stdout.match(/Tool created at: (.+)/)?.[1]?.trim();
  assert.ok(toolPath);
  assert.match(await readFile(toolPath, 'utf8'), /TOOLBOX_ACTION/);

  const listResult = runCovenCode(['tools', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /tb__run_tests\s+toolbox/);
});

test('tools make defaults to a Bun JavaScript toolbox scaffold', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  await mkdir(xdg, { recursive: true });

  const result = runCovenCode(['tools', 'make', 'current_time'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  const toolPath = result.stdout.match(/Tool created at: (.+)/)?.[1]?.trim();
  assert.ok(toolPath);
  const contents = await readFile(toolPath, 'utf8');
  assert.match(contents, /^#!\/usr\/bin\/env bun/);
  assert.match(contents, /const action = process\.env\.TOOLBOX_ACTION/);
  assert.match(contents, /function showDescription\(\)/);
});

test('COVEN_CODE_TOOLBOX scans multiple directories left-to-right and tools show renders JSON schemas', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const firstDir = path.join(home, 'first-tools');
  const secondDir = path.join(home, 'second-tools');
  await mkdir(firstDir, { recursive: true });
  await mkdir(secondDir, { recursive: true });

  const firstTool = path.join(firstDir, 'echo_context');
  const secondTool = path.join(secondDir, 'echo_context');
  await writeFile(firstTool, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({
    name: 'echo_context',
    description: 'First directory tool',
    input: {
      message: { type: 'string', description: 'Message to echo' }
    }
  }));
}
`);
  await writeFile(secondTool, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({
    name: 'echo_context',
    description: 'Second directory tool'
  }));
}
`);
  await chmod(firstTool, 0o755);
  await chmod(secondTool, 0o755);

  const env = { COVEN_CODE_TOOLBOX: [firstDir, secondDir].join(path.delimiter), HOME: home };
  const listResult = runCovenCode(['tools', 'list'], { env });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /tb__echo_context\s+toolbox\s+First directory tool/);
  assert.doesNotMatch(listResult.stdout, /Second directory tool/);

  const showResult = runCovenCode(['tools', 'show', 'tb__echo_context'], { env });
  assert.equal(showResult.status, 0, showResult.stderr);
  assert.match(showResult.stdout, /# tb__echo_context \(toolbox: /);
  assert.match(showResult.stdout, /First directory tool/);
  assert.match(showResult.stdout, /- message \(string\): Message to echo/);
});

test('tools show renders toolbox compact args and full inputSchema descriptions', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const toolsDir = path.join(home, 'tools');
  await mkdir(toolsDir, { recursive: true });

  const compactTool = path.join(toolsDir, 'compact_args');
  await writeFile(compactTool, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({
    name: 'compact_args',
    description: 'Compact args tool',
    args: {
      workspace: ['string', 'optional workspace directory'],
      force: ['boolean', 'whether to force the run']
    }
  }));
}
`);
  const schemaTool = path.join(toolsDir, 'full_schema');
  await writeFile(schemaTool, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({
    name: 'full_schema',
    description: 'Full schema tool',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'test name pattern' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'labels to include'
        }
      },
      required: ['pattern']
    }
  }));
}
`);
  await chmod(compactTool, 0o755);
  await chmod(schemaTool, 0o755);

  const compact = runCovenCode(['tools', 'show', 'tb__compact_args'], {
    env: { COVEN_CODE_TOOLBOX: toolsDir, HOME: home },
  });
  assert.equal(compact.status, 0, compact.stderr);
  assert.match(compact.stdout, /Compact args tool/);
  assert.match(compact.stdout, /- workspace \(string\): optional workspace directory/);
  assert.match(compact.stdout, /- force \(boolean\): whether to force the run/);

  const schema = runCovenCode(['tools', 'show', 'tb__full_schema'], {
    env: { COVEN_CODE_TOOLBOX: toolsDir, HOME: home },
  });
  assert.equal(schema.status, 0, schema.stderr);
  assert.match(schema.stdout, /Full schema tool/);
  assert.match(schema.stdout, /- pattern \(string\): test name pattern/);
  assert.match(schema.stdout, /- tags \(array<string>\): labels to include/);
  assert.doesNotMatch(schema.stdout, /- properties/);
});

test('tools use sends text-format toolbox arguments as colon-delimited key-value lines', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const toolsDir = path.join(home, 'tools');
  await mkdir(toolsDir, { recursive: true });

  const toolPath = path.join(toolsDir, 'text_input');
  await writeFile(toolPath, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  process.stdout.write('name: text_input\\n');
  process.stdout.write('description: Inspect text input\\n');
  process.stdout.write('action: string action to run\\n');
  process.exit(0);
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (input !== 'action: date\\n') {
    console.error('unexpected input: ' + JSON.stringify(input));
    process.exit(7);
  }
  process.stdout.write('ok text input\\n');
});
`);
  await chmod(toolPath, 0o755);

  const result = runCovenCode(['tools', 'use', '--only', 'output', 'tb__text_input', '--action', 'date'], {
    env: { COVEN_CODE_TOOLBOX: toolsDir, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ok text input\n');
});

test('tools show parses text toolbox multiline descriptions and optional default-string parameters', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const toolsDir = path.join(home, 'tools');
  await mkdir(toolsDir, { recursive: true });

  const toolPath = path.join(toolsDir, 'text_schema');
  await writeFile(toolPath, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  process.stdout.write('name: text_schema\\n');
  process.stdout.write('description: First description line.\\n');
  process.stdout.write('description: Second description line.\\n');
  process.stdout.write('workspace: string? workspace directory\\n');
  process.stdout.write('pattern: optional test pattern\\n');
  process.stdout.write('mode: string (optional) execution mode\\n');
}
`);
  await chmod(toolPath, 0o755);

  const result = runCovenCode(['tools', 'show', 'tb__text_schema'], {
    env: { COVEN_CODE_TOOLBOX: toolsDir, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /First description line\.\nSecond description line\./);
  assert.match(result.stdout, /- workspace \(string\): optional workspace directory/);
  assert.match(result.stdout, /- pattern \(string\): optional test pattern/);
  assert.match(result.stdout, /- mode \(string\): optional execution mode/);
});

test('--toolbox adds a one-run toolbox directory for lists and execute mode', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const toolsDir = path.join(home, 'cli-tools');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(toolsDir, { recursive: true });
  const toolPath = path.join(toolsDir, 'cli_context');
  await writeFile(toolPath, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({
    name: 'cli_context',
    description: 'CLI toolbox override tool',
    input: { message: { type: 'string', description: 'Message to echo' } }
  }));
  process.exit(0);
}
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({
    action: process.env.TOOLBOX_ACTION,
    message: JSON.parse(input).message
  }));
});
`);
  await chmod(toolPath, 0o755);
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.permissions': [{ action: 'allow', tool: 'tb__cli_context' }],
  }));

  const list = runCovenCode(['--toolbox', toolsDir, 'tools', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /tb__cli_context\s+toolbox\s+CLI toolbox override tool/);

  const result = runCovenCode(['--toolbox', toolsDir, '--execute', 'use tb__cli_context --message hello'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { action: 'execute', message: 'hello' });
});

test('tools use passes JSON arguments and Coven Code thread environment to toolbox executables', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const toolsDir = path.join(home, 'tools');
  await mkdir(toolsDir, { recursive: true });
  const toolPath = path.join(toolsDir, 'context_dump');
  await writeFile(toolPath, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({
    name: 'context_dump',
    description: 'Dump toolbox invocation context',
    input: {
      message: { type: 'string', description: 'Message to inspect' }
    }
  }));
  process.exit(0);
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({
    action: process.env.TOOLBOX_ACTION,
    agent: process.env.AGENT,
    covenCodeThreadId: process.env.COVEN_CODE_THREAD_ID,
    agentThreadId: process.env.AGENT_THREAD_ID,
    input: JSON.parse(input)
  }));
});
`);
  await chmod(toolPath, 0o755);

  const result = runCovenCode(['tools', 'use', 'tb__context_dump', '--thread', 'T-fixed-thread', '--message', 'hello'], {
    env: { COVEN_CODE_TOOLBOX: toolsDir, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.exitCode, 0);
  const output = JSON.parse(response.output);
  assert.equal(output.action, 'execute');
  assert.equal(output.agent, 'coven-code');
  assert.equal(output.covenCodeThreadId, 'T-fixed-thread');
  assert.equal(output.agentThreadId, 'T-fixed-thread');
  assert.deepEqual(output.input, { message: 'hello' });
});

test('execute mode can invoke an allowed toolbox tool', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const toolsDir = path.join(home, 'tools');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(toolsDir, { recursive: true });
  const toolPath = path.join(toolsDir, 'context_dump');
  await writeFile(toolPath, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({
    name: 'context_dump',
    description: 'Dump toolbox invocation context',
    input: {
      message: { type: 'string', description: 'Message to inspect' }
    }
  }));
  process.exit(0);
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  console.log(JSON.stringify({
    action: process.env.TOOLBOX_ACTION,
    agent: process.env.AGENT,
    threadId: process.env.COVEN_CODE_THREAD_ID,
    message: payload.message
  }));
});
`);
  await chmod(toolPath, 0o755);
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.permissions': [
      { action: 'allow', tool: 'tb__context_dump' },
    ],
  }));

  const result = runCovenCode(['--execute', 'use tb__context_dump --message hello'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_TOOLBOX: toolsDir },
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.action, 'execute');
  assert.equal(output.agent, 'coven-code');
  assert.match(output.threadId, /^T-/);
  assert.equal(output.message, 'hello');
});

test('execute mode honors delegated toolbox permission decisions', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const binDir = path.join(home, 'bin');
  const toolsDir = path.join(home, 'tools');
  const decisionPath = path.join(home, 'delegate-record.json');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(toolsDir, { recursive: true });

  const helperPath = path.join(binDir, 'coven-code-permission-helper');
  await writeFile(helperPath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  writeFileSync(process.env.DECISION_PATH, JSON.stringify({
    input: JSON.parse(input),
    agent: process.env.AGENT,
    toolName: process.env.AGENT_TOOL_NAME,
    threadId: process.env.COVEN_CODE_THREAD_ID,
    agentThreadId: process.env.AGENT_THREAD_ID
  }));
  process.exit(0);
});
`);
  await chmod(helperPath, 0o755);

  const toolPath = path.join(toolsDir, 'context_dump');
  await writeFile(toolPath, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({
    name: 'context_dump',
    description: 'Dump toolbox invocation context',
    input: {
      message: { type: 'string', description: 'Message to inspect' }
    }
  }));
  process.exit(0);
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  console.log(JSON.stringify({ message: payload.message, threadId: process.env.COVEN_CODE_THREAD_ID }));
});
`);
  await chmod(toolPath, 0o755);
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.permissions': [
      { action: 'delegate', to: 'coven-code-permission-helper', tool: 'tb__context_dump' },
    ],
  }));

  const result = runCovenCode(['--execute', 'use tb__context_dump --message hello'], {
    env: {
      XDG_CONFIG_HOME: xdg,
      HOME: home,
      COVEN_CODE_TOOLBOX: toolsDir,
      DECISION_PATH: decisionPath,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const toolOutput = JSON.parse(result.stdout);
  assert.equal(toolOutput.message, 'hello');
  assert.match(toolOutput.threadId, /^T-/);
  assert.deepEqual(JSON.parse(await readFile(decisionPath, 'utf8')), {
    input: { message: 'hello' },
    agent: 'coven-code',
    toolName: 'tb__context_dump',
    threadId: toolOutput.threadId,
    agentThreadId: toolOutput.threadId,
  });
});

test('--dangerously-allow-all bypasses delegated permission helpers', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const binDir = path.join(home, 'bin');
  const toolsDir = path.join(home, 'tools');
  const markerPath = path.join(home, 'delegate-called');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(toolsDir, { recursive: true });

  const helperPath = path.join(binDir, 'coven-code-deny-helper');
  await writeFile(helperPath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

writeFileSync(process.env.MARKER_PATH, 'called');
console.error('delegate should not run');
process.exit(2);
`);
  await chmod(helperPath, 0o755);

  const toolPath = path.join(toolsDir, 'context_dump');
  await writeFile(toolPath, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({
    name: 'context_dump',
    description: 'Dump toolbox invocation context',
    input: {
      message: { type: 'string', description: 'Message to inspect' }
    }
  }));
  process.exit(0);
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  console.log(JSON.stringify({ message: payload.message }));
});
`);
  await chmod(toolPath, 0o755);
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.permissions': [
      { action: 'delegate', to: 'coven-code-deny-helper', tool: 'tb__context_dump' },
    ],
  }));

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use tb__context_dump --message hello',
  ], {
    env: {
      XDG_CONFIG_HOME: xdg,
      HOME: home,
      COVEN_CODE_TOOLBOX: toolsDir,
      MARKER_PATH: markerPath,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { message: 'hello' });
  await assert.rejects(readFile(markerPath, 'utf8'), { code: 'ENOENT' });
});

test('covenCode.dangerouslyAllowAll setting bypasses delegated permission helpers', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const binDir = path.join(home, 'bin');
  const toolsDir = path.join(home, 'tools');
  const markerPath = path.join(home, 'delegate-called');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(toolsDir, { recursive: true });

  const helperPath = path.join(binDir, 'coven-code-deny-helper');
  await writeFile(helperPath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

writeFileSync(process.env.MARKER_PATH, 'called');
console.error('delegate should not run');
process.exit(2);
`);
  await chmod(helperPath, 0o755);

  const toolPath = path.join(toolsDir, 'context_dump');
  await writeFile(toolPath, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({
    name: 'context_dump',
    description: 'Dump toolbox invocation context',
    input: {
      message: { type: 'string', description: 'Message to inspect' }
    }
  }));
  process.exit(0);
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  console.log(JSON.stringify({ message: payload.message }));
});
`);
  await chmod(toolPath, 0o755);
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.dangerouslyAllowAll': true,
    'covenCode.permissions': [
      { action: 'delegate', to: 'coven-code-deny-helper', tool: 'tb__context_dump' },
    ],
  }));

  const result = runCovenCode([
    '--execute',
    'use tb__context_dump --message hello',
  ], {
    env: {
      XDG_CONFIG_HOME: xdg,
      HOME: home,
      COVEN_CODE_TOOLBOX: toolsDir,
      MARKER_PATH: markerPath,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { message: 'hello' });
  await assert.rejects(readFile(markerPath, 'utf8'), { code: 'ENOENT' });
});

test('stream json emits toolbox tool_use and tool_result events', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const toolsDir = path.join(home, 'tools');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(toolsDir, { recursive: true });
  const toolPath = path.join(toolsDir, 'context_dump');
  await writeFile(toolPath, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({
    name: 'context_dump',
    description: 'Dump toolbox invocation context',
    input: {
      message: { type: 'string', description: 'Message to inspect' }
    }
  }));
  process.exit(0);
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  console.log(JSON.stringify({
    action: process.env.TOOLBOX_ACTION,
    message: payload.message
  }));
});
`);
  await chmod(toolPath, 0o755);
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.permissions': [
      { action: 'allow', tool: 'tb__context_dump' },
    ],
  }));

  const result = runCovenCode(['--execute', 'use tb__context_dump --message hello', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_TOOLBOX: toolsDir },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.type), ['system', 'user', 'assistant', 'user', 'assistant', 'result']);
  assert.equal(messages[2].parent_tool_use_id, null);
  const toolUse = messages[2].message.content[0];
  assert.equal(toolUse.type, 'tool_use');
  assert.equal(toolUse.name, 'tb__context_dump');
  assert.deepEqual(toolUse.input, { message: 'hello' });
  assert.equal(messages[3].parent_tool_use_id, null);
  const toolResult = messages[3].message.content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, toolUse.id);
  assert.match(toolResult.content, /"message":"hello"/);
  assert.equal(messages[4].parent_tool_use_id, null);
  assert.match(messages[4].message.content[0].text, /"message":"hello"/);
  assert.equal(messages[5].num_turns, 2);
  assert.match(messages[5].result, /"message":"hello"/);
});

test('stream json reports toolbox permission denials in the final result', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const toolsDir = path.join(home, 'tools');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(toolsDir, { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.dangerouslyAllowAll': false,
  }));
  const toolPath = path.join(toolsDir, 'context_dump');
  await writeFile(toolPath, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({
    name: 'context_dump',
    description: 'Dump toolbox invocation context',
    input: {
      message: { type: 'string', description: 'Message to inspect' }
    }
  }));
  process.exit(0);
}

console.log('should not run');
`);
  await chmod(toolPath, 0o755);

  const result = runCovenCode(['--execute', 'use tb__context_dump --message hello', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_TOOLBOX: toolsDir },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const final = messages.at(-1);
  assert.equal(final.type, 'result');
  assert.match(final.result, /Permission denied for tb__context_dump/);
  assert.deepEqual(final.permission_denials, [
    'tb__context_dump: reject (permission)',
  ]);
});

test('agents list reports cwd, parent, and user guidance files', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo', 'app');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'AGENTS.md'), 'Personal guidance\n');
  await writeFile(path.join(home, 'repo', 'AGENTS.md'), 'Repo guidance\n');
  await writeFile(path.join(workspace, 'CLAUDE.md'), 'Fallback guidance\n');

  const result = runCovenCode(['agents', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.ok(lines.some((line) => line.endsWith('/.config/coven-code/AGENTS.md')));
  assert.ok(lines.some((line) => line.endsWith('/repo/AGENTS.md')));
  assert.ok(lines.some((line) => line.endsWith('/repo/app/CLAUDE.md')));
});

test('agents-md list aliases the command-palette AGENTS.md command', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'AGENTS.md'), 'Personal guidance\n');
  await writeFile(path.join(workspace, 'AGENTS.md'), 'Project guidance\n');

  const result = runCovenCode(['agents-md', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.ok(lines.some((line) => line.endsWith('/.config/coven-code/AGENTS.md')));
  assert.ok(lines.some((line) => line.endsWith('/repo/AGENTS.md')));
});

test('agents list includes home config guidance even with custom XDG_CONFIG_HOME', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, 'xdg');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(home, '.config', 'coven-code'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'AGENTS.md'), 'XDG covenCode guidance\n');
  await writeFile(path.join(home, '.config', 'coven-code', 'AGENTS.md'), 'Home covenCode guidance\n');
  await writeFile(path.join(home, '.config', 'AGENTS.md'), 'Home config guidance\n');

  const result = runCovenCode(['agents', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.ok(lines.some((line) => line.endsWith('/xdg/coven-code/AGENTS.md')));
  assert.ok(lines.some((line) => line.endsWith('/.config/coven-code/AGENTS.md')));
  assert.ok(lines.some((line) => line.endsWith('/.config/AGENTS.md')));
});

test('agents list includes fallback guidance filenames in global config directories', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, 'xdg');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(home, '.config', 'coven-code'), { recursive: true });
  await mkdir(path.join(home, '.config'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'AGENT.md'), 'XDG fallback guidance\n');
  await writeFile(path.join(home, '.config', 'coven-code', 'CLAUDE.md'), 'Home covenCode fallback guidance\n');
  await writeFile(path.join(home, '.config', 'AGENTS.md'), 'Home config guidance\n');
  await writeFile(path.join(home, '.config', 'CLAUDE.md'), 'Home config fallback ignored\n');

  const result = runCovenCode(['agents', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.ok(lines.some((line) => line.endsWith('/xdg/coven-code/AGENT.md')));
  assert.ok(lines.some((line) => line.endsWith('/.config/coven-code/CLAUDE.md')));
  assert.ok(lines.some((line) => line.endsWith('/.config/AGENTS.md')));
  assert.ok(!lines.some((line) => line.endsWith('/.config/CLAUDE.md')));
});

test('agents list includes Windows ProgramData system guidance', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, 'xdg');
  const programData = path.join(home, 'ProgramData');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(programData, 'coven-code'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(programData, 'coven-code', 'AGENTS.md'), 'Windows system guidance\n');

  const result = runCovenCode(['agents', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, ProgramData: programData },
  });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.ok(lines.some((line) => line.endsWith('/ProgramData/coven-code/AGENTS.md')));
});

test('execute mode includes AGENTS.md @mentioned files outside code blocks', async () => {
  const workspace = await makeWorkspace();
  await mkdir(path.join(workspace, 'docs'), { recursive: true });
  await writeFile(path.join(workspace, 'AGENTS.md'), `Read @docs/team.md before answering.

\`\`\`
Ignore this example reference: @docs/decoy.md
\`\`\`
`);
  await writeFile(path.join(workspace, 'docs', 'team.md'), 'codename: maple-lantern\n');
  await writeFile(path.join(workspace, 'docs', 'decoy.md'), 'codename: decoy-river\n');

  const result = runCovenCode(['--execute', 'what codename is in the guidance files?'], { cwd: workspace });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'maple-lantern');
});

test('execute mode filters AGENTS.md @mentioned files by frontmatter globs', async () => {
  const workspace = await makeWorkspace();
  await mkdir(path.join(workspace, 'docs'), { recursive: true });
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'AGENTS.md'), 'Read @docs/*.md before answering.\n');
  await writeFile(path.join(workspace, 'README.md'), '# Fixture\n');
  await writeFile(path.join(workspace, 'src', 'app.ts'), 'export const app = true;\n');
  await writeFile(path.join(workspace, 'docs', 'common.md'), 'codename: common-lantern\n');
  await writeFile(path.join(workspace, 'docs', 'typescript.md'), `---
globs:
  - '**/*.ts'
---
codename: ts-lantern
`);

  const readme = runCovenCode(['--execute', 'list the codenames from guidance for @README.md'], { cwd: workspace });
  assert.equal(readme.status, 0, readme.stderr);
  assert.equal(readme.stdout.trim(), 'common-lantern');

  const ts = runCovenCode(['--execute', 'list the codenames from guidance for @src/app.ts'], { cwd: workspace });
  assert.equal(ts.status, 0, ts.stderr);
  assert.equal(ts.stdout.trim(), 'common-lantern\nts-lantern');
});

test('execute mode includes subtree AGENTS.md when reading files below it', async () => {
  const workspace = await makeWorkspace();
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# Fixture\n');
  await writeFile(path.join(workspace, 'src', 'app.ts'), 'export const app = true;\n');
  await writeFile(path.join(workspace, 'src', 'AGENTS.md'), 'codename: subtree-lantern\n');

  const readme = runCovenCode(['--execute', 'what codename is in guidance for @README.md?'], { cwd: workspace });
  assert.equal(readme.status, 0, readme.stderr);
  assert.match(readme.stdout, /No codename was found/);

  const source = runCovenCode(['--execute', 'what codename is in guidance for @src/app.ts?'], { cwd: workspace });
  assert.equal(source.status, 0, source.stderr);
  assert.equal(source.stdout.trim(), 'subtree-lantern');
});

test('plugins list reports project and user plugin files', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code', 'plugins'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'project-status.ts'), 'export default function projectStatus() {}\n');
  await writeFile(path.join(xdg, 'coven-code', 'plugins', 'notify.ts'), 'export default function notify() {}\n');

  const result = runCovenCode(['plugins', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.ok(lines.some((line) => line.includes('project-status') && line.includes('project') && line.endsWith('/repo/.coven-code/plugins/project-status.ts')));
  assert.ok(lines.some((line) => line.includes('notify') && line.includes('user') && line.endsWith('/.config/coven-code/plugins/notify.ts')));
});

test('plugins list reports Coven Code project and user plugin files', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code', 'plugins'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'project-status.ts'), 'export default function projectStatus() {}\n');
  await writeFile(path.join(xdg, 'coven-code', 'plugins', 'notify.ts'), 'export default function notify() {}\n');

  const result = runCovenCode(['plugins', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.ok(lines.some((line) => line.includes('project-status') && line.includes('project') && line.endsWith('/repo/.coven-code/plugins/project-status.ts')));
  assert.ok(lines.some((line) => line.includes('notify') && line.includes('user') && line.endsWith('/.config/coven-code/plugins/notify.ts')));
});

test('plugins list reports registered tools commands and events', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'project-status.ts'), `
export default function (covenCode) {
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'clean';
    },
  });
  covenCode.registerCommand('open-project-status', { title: 'Open project status' }, async () => 'opened');
  covenCode.on('agent.start', async () => {});
}
`);

  const result = runCovenCode(['plugins', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /project-status\s+project\s+tools=project_status\s+commands=open-project-status\s+events=agent\.start/);
});

test('plugin event registration subscriptions can unsubscribe', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(home, 'events.log');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'events.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  const subscription = covenCode.on('session.start', async () => {
    appendFileSync(${JSON.stringify(marker)}, 'session.start\\n');
  });
  subscription.unsubscribe();
  covenCode.on('agent.start', async () => {
    appendFileSync(${JSON.stringify(marker)}, 'agent.start\\n');
  });
}
`);

  const plugins = runCovenCode(['plugins', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(plugins.status, 0, plugins.stderr);
  assert.match(plugins.stdout, /events\s+project\s+tools=-\s+commands=-\s+events=agent\.start/);
  assert.doesNotMatch(plugins.stdout, /session\.start/);

  const execute = runCovenCode(['--execute', 'run subscribed event'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(execute.status, 0, execute.stderr);
  assert.equal(await readFile(marker, 'utf8'), 'agent.start\n');
});

test('plugins reload validates plugins and reports registration counts', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'reloadable.ts'), `
export default function (covenCode) {
  covenCode.registerTool({
    name: 'reload_status',
    description: 'Show reload status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'fresh';
    },
  });
  covenCode.registerCommand('reload-dashboard', { title: 'Reload dashboard' }, async () => 'opened');
  covenCode.on('session.start', async () => {});
  covenCode.on('agent.end', async () => {});
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reloaded 1 plugin\(s\)\./);
  assert.match(result.stdout, /reloadable\s+project\s+tools=reload_status\s+commands=reload-dashboard\s+events=session\.start,agent\.end/);
});

test('plugin tool names must match the documented identifier pattern', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-tool.ts'), `
export default function (covenCode) {
  covenCode.registerTool({
    name: 'bad tool name',
    description: 'Invalid tool name with spaces',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'should not register';
    },
  });
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
assert.match(result.stderr, /plugin tool name must match \^\[a-zA-Z0-9_-\]\+\$: bad tool name/);
}
);

test('plugin tool definitions require a description', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-tool.ts'), `
export default function (covenCode) {
  covenCode.registerTool({
    name: 'missing_description',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'should not register';
    },
  });
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin tool description is required: missing_description/);
});

test('plugin tool definitions require an object input schema', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-tool.ts'), `
export default function (covenCode) {
  covenCode.registerTool({
    name: 'bad_schema',
    description: 'Uses an invalid input schema.',
    inputSchema: { type: 'array' },
    async execute() {
      return 'should not register';
    },
  });
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin tool inputSchema.type must be object: bad_schema/);
});

test('plugin tool input schema properties must be objects', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-tool.ts'), `
export default function (covenCode) {
  covenCode.registerTool({
    name: 'bad_properties',
    description: 'Uses invalid schema properties.',
    inputSchema: { type: 'object', properties: { branch: 'main' }, required: [] },
    async execute() {
      return 'should not register';
    },
  });
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin tool inputSchema.properties values must be objects: bad_properties/);
});

test('plugin tool input schema required must be strings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-tool.ts'), `
export default function (covenCode) {
  covenCode.registerTool({
    name: 'bad_required',
    description: 'Uses an invalid required list.',
    inputSchema: { type: 'object', properties: {}, required: ['branch', 42] },
    async execute() {
      return 'should not register';
    },
  });
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin tool inputSchema.required must be strings: bad_required/);
});

test('plugin tool definitions require an execute handler', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-tool.ts'), `
export default function (covenCode) {
  covenCode.registerTool({
    name: 'missing_execute',
    description: 'No execute handler.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  });
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin tool execute handler is required: missing_execute/);
});

test('tools list includes tools registered by project plugins', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'project-tools.ts'), `
export default function (covenCode) {
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'clean';
    },
  });
}
`);

  const result = runCovenCode(['tools', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /project_status\s+plugin\s+Show the current project status/);
});

test('plugin tool registration subscriptions can unsubscribe', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'project-tools.ts'), `
export default function (covenCode) {
  const subscription = covenCode.registerTool({
    name: 'temporary_probe',
    description: 'Temporary plugin tool',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'temporary';
    },
  });
  subscription.unsubscribe();
  covenCode.registerTool({
    name: 'permanent_probe',
    description: 'Permanent plugin tool',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'permanent';
    },
  });
}
`);

  const tools = runCovenCode(['tools', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  const plugins = runCovenCode(['plugins', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(tools.status, 0, tools.stderr);
  assert.match(tools.stdout, /permanent_probe\s+plugin\s+Permanent plugin tool/);
  assert.doesNotMatch(tools.stdout, /temporary_probe/);
  assert.equal(plugins.status, 0, plugins.stderr);
  assert.match(plugins.stdout, /project-tools\s+project\s+tools=permanent_probe/);
  assert.doesNotMatch(plugins.stdout, /temporary_probe/);
});

test('stream json init includes tools registered by project plugins', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'project-tools.ts'), `
export default function (covenCode) {
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'clean';
    },
  });
}
`);

  const result = runCovenCode(['--execute', 'what tools are available?', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const system = JSON.parse(result.stdout.trim().split('\n')[0]);
  assert.ok(system.tools.includes('project_status'));
});

test('execute mode can invoke a plugin-registered tool', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'project-tools.ts'), `
export default function (covenCode) {
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string' }
      },
      required: []
    },
    async execute(input) {
      return JSON.stringify({ status: 'clean', format: input.format });
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use project_status --format short'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'clean', format: 'short' });
});

test('plugin tool execute handlers receive UI and logger context', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'context-tools.ts'), `
export default function (covenCode) {
  covenCode.registerTool({
    name: 'context_probe',
    description: 'Inspect plugin tool context',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    async execute(_input, ctx) {
      ctx.logger.log('context_probe executed');
      await ctx.ui.notify('context probe notification');
      const note = await ctx.ui.input({
        title: 'Tool note',
        initialValue: 'context-default',
      });
      return JSON.stringify({
        hasLogger: typeof ctx.logger.log === 'function',
        loggerKeys: Object.keys(ctx.logger).sort(),
        note,
      });
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use context_probe'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    hasLogger: true,
    loggerKeys: ['log'],
    note: 'context-default',
  });
});

test('plugin tool execute handlers can return structured content blocks', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'structured-tools.ts'), `
export default function (covenCode) {
  covenCode.registerTool({
    name: 'structured_probe',
    description: 'Return structured plugin content',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    async execute() {
      return [
        { type: 'text', text: 'structured hello' },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      ];
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use structured_probe', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const toolResult = messages.find((message) => message.type === 'user' && message.message.content[0]?.type === 'tool_result');
  assert.ok(toolResult);
  assert.deepEqual(toolResult.message.content[0].content, [
    { type: 'text', text: 'structured hello' },
    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
  ]);
  const final = messages.at(-1);
  assert.equal(final.type, 'result');
  assert.equal(final.result, 'structured hello');
});

test('plugin tool execute results must be strings content blocks or void', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-tool-result.ts'), `
export default function (covenCode) {
  covenCode.registerTool({
    name: 'invalid_result_probe',
    description: 'Return an invalid plugin tool result',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    async execute() {
      return 42;
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use invalid_result_probe'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin tool result must be a string, content blocks, or undefined/);
});

test('plugin tool execute content blocks must match the documented shape', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-block.ts'), `
export default function (covenCode) {
  covenCode.registerTool({
    name: 'invalid_block_probe',
    description: 'Return an invalid plugin content block',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    async execute() {
      return [{ type: 'text', text: 42 }];
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use invalid_block_probe'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin tool result content blocks must be text or image blocks/);
});

test('stream json input preserves structured plugin tool result content blocks', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'structured-tools.ts'), `
export default function (covenCode) {
  covenCode.registerTool({
    name: 'structured_probe',
    description: 'Return structured plugin content',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    async execute() {
      return [
        { type: 'text', text: 'structured hello' },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      ];
    },
  });
}
`);
  const input = `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'use structured_probe' }],
    },
  })}\n`;

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    '--stream-json',
    '--stream-json-input',
  ], {
    cwd: workspace,
    input,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const toolResult = messages.find((message) => message.type === 'user' && message.message.content[0]?.type === 'tool_result');
  assert.deepEqual(toolResult.message.content[0].content, [
    { type: 'text', text: 'structured hello' },
    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
  ]);
  assert.equal(messages.at(-1).result, 'structured hello');
});

test('plugin tool.call handlers can reject plugin tool execution', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'guarded-tools.ts'), `
export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'project_status') {
      return { action: 'reject-and-continue', message: 'blocked by plugin policy' };
    }
    return { action: 'allow' };
  });
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'should not run';
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use project_status'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'blocked by plugin policy');
});

test('plugin tool.call handlers can stop execution with an error action', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'plugin-tool-ran');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'error-tools.ts'), `
import { writeFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'project_status') {
      return { action: 'error', message: 'plugin policy crashed safely' };
    }
  });
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      writeFileSync(${JSON.stringify(marker)}, 'ran');
      return 'should not run';
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use project_status', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const toolResult = messages.find((message) => message.type === 'user' && message.message.content[0]?.type === 'tool_result');
  assert.ok(toolResult);
  assert.equal(toolResult.message.content[0].content, 'plugin policy crashed safely');
  assert.equal(toolResult.message.content[0].is_error, true);
});

test('plugin tool.call handlers can synthesize plugin tool results without execution', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'plugin-tool-ran');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'synthesized-tools.ts'), `
import { writeFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'project_status') {
      return { action: 'synthesize', result: { output: 'synthesized project status', exitCode: 0 } };
    }
  });
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      writeFileSync(${JSON.stringify(marker)}, 'ran');
      return 'raw project status';
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use project_status'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'synthesized project status');
  await assert.rejects(readFile(marker, 'utf8'), /ENOENT/);
});

test('plugin tool.call reject decisions require a string message', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-reject.ts'), `
export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'project_status') {
      return { action: 'reject-and-continue' };
    }
  });
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'should not run';
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use project_status'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin tool.call reject-and-continue message must be a string/);
});

test('plugin tool.call modify decisions require object input', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-modify.ts'), `
export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'project_status') {
      return { action: 'modify', input: 'not an object' };
    }
  });
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'should not run';
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use project_status'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin tool.call modify input must be an object/);
});

test('plugin tool.call synthesize decisions require string output', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-synthesize.ts'), `
export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'project_status') {
      return { action: 'synthesize', result: { output: 42 } };
    }
  });
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'should not run';
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use project_status'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin tool.call synthesize result.output must be a string/);
});

test('plugin tool.call decisions must be objects', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-tool-call-result.ts'), `
export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'project_status') {
      return 'allow';
    }
  });
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'should not run';
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use project_status'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin tool.call result must be an object/);
});

test('plugin tool.call decisions require documented actions', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-tool-call-action.ts'), `
export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'project_status') {
      return { action: 'pause', message: 'not documented' };
    }
  });
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'should not run';
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use project_status'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin tool.call action must be allow, reject-and-continue, modify, synthesize, or error/);
});

test('plugin tool.call decisions reject fields outside the documented union', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-tool-call-fields.ts'), `
export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'project_status') {
      return { action: 'allow', message: 'extra field' };
    }
  });
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'should not run';
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use project_status'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin tool.call fields must match the documented union/);
});

test('plugin tool.result handlers can replace plugin tool output', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'plugin-tool-events.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'redact-tools.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'project_secret') {
      appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
        type: 'call',
        toolUseID: event.toolUseID,
        threadId: event.thread.id,
      }) + '\\n');
    }
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'project_secret') {
      appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
        type: 'result',
        toolUseID: event.toolUseID,
        threadId: event.thread.id,
        status: event.status,
        output: event.output,
      }) + '\\n');
      return { status: 'done', output: 'redacted result' };
    }
  });
  covenCode.registerTool({
    name: 'project_secret',
    description: 'Show the current project secret',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'raw result';
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use project_secret'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'redacted result');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.length, 2);
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.match(events[0].threadId, /^T-/);
  assert.deepEqual(events[1], {
    type: 'result',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    status: 'done',
    output: 'raw result',
  });
});

test('plugin tool.result handlers can mark plugin tool results as errors', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'agent-end.json');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'tool-result-error.ts'), `
import { writeFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'project_status') {
      return { status: 'error', error: 'status lookup failed' };
    }
  });
  covenCode.on('agent.end', async (event) => {
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ status: event.status }));
  });
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'raw status';
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use project_status', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const toolResult = messages.find((message) => message.type === 'user' && message.message.content[0]?.type === 'tool_result');
  assert.equal(toolResult.message.content[0].is_error, true);
  assert.equal(toolResult.message.content[0].content, 'status lookup failed');
  assert.equal(messages.at(-1).is_error, true);
  assert.equal(messages.at(-1).subtype, 'error_during_execution');
  assert.equal(messages.at(-1).error, 'status lookup failed');
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { status: 'error' });
});

test('plugin tool.result handlers must return documented statuses', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-tool-result-status.ts'), `
export default function (covenCode) {
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'project_status') {
      return { status: 'paused', output: 'ignored' };
    }
  });
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'raw status';
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use project_status'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin tool\.result status must be done, error, or cancelled/);
});

test('plugin tool.result error status requires string error when present', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-tool-result-error.ts'), `
export default function (covenCode) {
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'project_status') {
      return { status: 'error', error: { message: 'bad' } };
    }
  });
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'raw status';
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use project_status'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin tool\.result error must be a string/);
});

test('plugin tool.result decisions reject fields outside the documented union', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-tool-result-fields.ts'), `
export default function (covenCode) {
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'project_status') {
      return { status: 'done', output: 'redacted', error: 'extra field' };
    }
  });
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'raw status';
    },
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use project_status'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin tool\.result fields must match the documented union/);
});

test('stream json input final result reflects plugin tool.result errors', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'agent-end.json');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'stream-input-tool-result-error.ts'), `
import { writeFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'project_status') {
      return { status: 'error', error: 'stream input status lookup failed' };
    }
  });
  covenCode.on('agent.end', async (event) => {
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ status: event.status }));
  });
  covenCode.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'raw status';
    },
  });
}
`);
  const input = `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'use project_status' }],
    },
  })}\n`;

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    '--stream-json',
    '--stream-json-input',
  ], {
    cwd: workspace,
    input,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const toolResult = messages.find((message) => message.type === 'user' && message.message.content[0]?.type === 'tool_result');
  assert.equal(toolResult.message.content[0].is_error, true);
  assert.equal(toolResult.message.content[0].content, 'stream input status lookup failed');
  assert.equal(messages.at(-1).is_error, true);
  assert.equal(messages.at(-1).subtype, 'error_during_execution');
  assert.equal(messages.at(-1).error, 'stream input status lookup failed');
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { status: 'error' });
});

test('plugin tool.call handlers can reject toolbox tool execution', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const toolsDir = path.join(home, 'tools');
  const marker = path.join(workspace, 'tool-call.json');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await mkdir(toolsDir, { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.permissions': [{ action: 'allow', tool: 'tb__context_dump' }],
  }));
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'tool-call.ts'), `
import { writeFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'tb__context_dump') {
      writeFileSync(${JSON.stringify(marker)}, JSON.stringify(event));
      return { action: 'reject-and-continue', message: 'blocked toolbox tool' };
    }
  });
}
`);
  const toolPath = path.join(toolsDir, 'context_dump');
  await writeFile(toolPath, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({
    name: 'context_dump',
    description: 'Dump toolbox invocation context',
    input: {
      message: { type: 'string', description: 'Message to inspect' }
    }
  }));
  process.exit(0);
}
console.log('toolbox ran');
`);
  await chmod(toolPath, 0o755);

  const result = runCovenCode(['--execute', 'use tb__context_dump --message hello'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_TOOLBOX: toolsDir },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'blocked toolbox tool');
  const event = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(event.tool, 'tb__context_dump');
  assert.deepEqual(event.input, { message: 'hello' });
});

test('toolbox plugin tool events expose thread and matching tool use ids', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const toolsDir = path.join(home, 'tools');
  const marker = path.join(workspace, 'toolbox-events.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await mkdir(toolsDir, { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.permissions': [{ action: 'allow', tool: 'tb__context_dump' }],
  }));
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'toolbox-events.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'tb__context_dump') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'tb__context_dump') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'result',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
      status: event.status,
      output: event.output,
    }) + '\\n');
  });
}
`);
  const toolPath = path.join(toolsDir, 'context_dump');
  await writeFile(toolPath, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({
    name: 'context_dump',
    description: 'Dump toolbox invocation context',
    input: {
      message: { type: 'string', description: 'Message to inspect' }
    }
  }));
  process.exit(0);
}
console.log('raw toolbox result');
`);
  await chmod(toolPath, 0o755);

  const result = runCovenCode(['--execute', 'use tb__context_dump --message hello', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_TOOLBOX: toolsDir },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const toolUse = messages.find((message) => message.message?.content?.[0]?.type === 'tool_use').message.content[0];
  const final = messages.at(-1);
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.equal(events[0].toolUseID, toolUse.id);
  assert.equal(events[0].threadId, final.session_id);
  assert.deepEqual(events[0], {
    type: 'call',
    toolUseID: toolUse.id,
    threadId: final.session_id,
    input: { message: 'hello' },
  });
  assert.deepEqual(events[1], {
    type: 'result',
    toolUseID: toolUse.id,
    threadId: final.session_id,
    input: { message: 'hello' },
    status: 'done',
    output: 'raw toolbox result',
  });
});

test('plugin tool.result handlers can replace toolbox tool output', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const toolsDir = path.join(home, 'tools');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await mkdir(toolsDir, { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.permissions': [{ action: 'allow', tool: 'tb__context_dump' }],
  }));
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'tool-result.ts'), `
export default function (covenCode) {
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'tb__context_dump') {
      return { status: 'done', output: 'redacted toolbox result' };
    }
  });
}
`);
  const toolPath = path.join(toolsDir, 'context_dump');
  await writeFile(toolPath, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({
    name: 'context_dump',
    description: 'Dump toolbox invocation context',
    input: {
      message: { type: 'string', description: 'Message to inspect' }
    }
  }));
  process.exit(0);
}
console.log('raw toolbox result');
`);
  await chmod(toolPath, 0o755);

  const result = runCovenCode(['--execute', 'use tb__context_dump --message hello'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_TOOLBOX: toolsDir },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'redacted toolbox result');
});

test('plugin tool.result handlers can mark toolbox tool results as errors', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const toolsDir = path.join(home, 'tools');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await mkdir(toolsDir, { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.permissions': [{ action: 'allow', tool: 'tb__context_dump' }],
  }));
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'tool-result-error.ts'), `
export default function (covenCode) {
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'tb__context_dump') {
      return { status: 'error', error: 'toolbox output rejected by plugin' };
    }
  });
}
`);
  const toolPath = path.join(toolsDir, 'context_dump');
  await writeFile(toolPath, `#!/usr/bin/env node
if (process.env.TOOLBOX_ACTION === 'describe') {
  console.log(JSON.stringify({
    name: 'context_dump',
    description: 'Dump toolbox invocation context',
    input: {
      message: { type: 'string', description: 'Message to inspect' }
    }
  }));
  process.exit(0);
}
console.log('raw toolbox result');
`);
  await chmod(toolPath, 0o755);

  const result = runCovenCode(['--execute', 'use tb__context_dump --message hello', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_TOOLBOX: toolsDir },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const toolResult = messages.find((message) => message.type === 'user' && message.message.content[0]?.type === 'tool_result');
  assert.equal(toolResult.message.content[0].is_error, true);
  assert.equal(toolResult.message.content[0].content, 'toolbox output rejected by plugin');
  assert.equal(messages.at(-1).is_error, true);
  assert.equal(messages.at(-1).subtype, 'error_during_execution');
  assert.equal(messages.at(-1).error, 'toolbox output rejected by plugin');
});

test('plugin helpers can inspect built-in Bash tool calls before execution', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'bash-helper.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bash-policy.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    const shellCommand = covenCode.helpers.shellCommandFromToolCall(event);
    if (shellCommand?.command) {
      appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
        type: 'call',
        toolUseID: event.toolUseID,
        threadId: event.thread.id,
        shellCommand,
      }) + '\\n');
    }
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'Bash') {
      appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
        type: 'result',
        toolUseID: event.toolUseID,
        threadId: event.thread.id,
        status: event.status,
        output: event.output,
      }) + '\\n');
    }
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use Bash --command "printf helper-ok"'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'helper-ok');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.length, 2);
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.match(events[0].threadId, /^T-/);
  assert.deepEqual(events[0].shellCommand, { command: 'printf helper-ok' });
  assert.deepEqual(events[1], {
    type: 'result',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    status: 'done',
    output: 'helper-ok',
  });
});

test('plugin tool.call handlers can reject built-in Bash with stream-json tool result', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bash-reject.ts'), `
export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'Bash') {
      return { action: 'reject-and-continue', message: 'blocked bash by plugin policy' };
    }
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use Bash --command "printf should-not-run"', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const toolUse = messages.find((message) => message.message?.content?.[0]?.type === 'tool_use').message.content[0];
  const toolResult = messages.find((message) => message.message?.content?.[0]?.type === 'tool_result').message.content[0];
  assert.equal(toolUse.name, 'Bash');
  assert.deepEqual(toolUse.input, { command: 'printf should-not-run', cmd: 'printf should-not-run' });
  assert.equal(toolResult.tool_use_id, toolUse.id);
  assert.equal(toolResult.content, 'blocked bash by plugin policy');
  assert.equal(toolResult.is_error, false);
  assert.equal(messages.at(-1).result, 'blocked bash by plugin policy');
});

test('plugin tool.result handlers can mark built-in Bash results as errors', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bash-result-error.ts'), `
export default function (covenCode) {
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'Bash') {
      return { status: 'error', error: 'bash output rejected by plugin' };
    }
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use Bash --command "printf helper-ok"', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const toolResult = messages.find((message) => message.type === 'user' && message.message.content[0]?.type === 'tool_result');
  assert.equal(toolResult.message.content[0].is_error, true);
  assert.equal(toolResult.message.content[0].content, 'bash output rejected by plugin');
  assert.equal(messages.at(-1).is_error, true);
  assert.equal(messages.at(-1).subtype, 'error_during_execution');
  assert.equal(messages.at(-1).error, 'bash output rejected by plugin');
});

test('plugin shellCommandFromToolCall supports shell_command tool events', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'shell-command-helper.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'inspect-shell-command-tool',
    {
      title: 'Inspect shell_command tool',
      category: 'runtime',
    },
    async () => {
      const shellCommand = covenCode.helpers.shellCommandFromToolCall({
        tool: 'shell_command',
        input: { command: 'npm test', dir: 'packages/api' },
      });
      return JSON.stringify(shellCommand);
    },
  );
}
`);

  const result = runCovenCode(['plugins', 'run', 'inspect-shell-command-tool'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { command: 'npm test', dir: 'packages/api' });
});

test('plugin helpers return null for non-shell and non-mutating tool calls', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'null-helpers.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'inspect-null-helpers',
    {
      title: 'Inspect null helpers',
      category: 'runtime',
    },
    async () => {
      return JSON.stringify({
        nonShell: covenCode.helpers.shellCommandFromToolCall({ tool: 'Read', input: { path: 'README.md' } }),
        missingCommand: covenCode.helpers.shellCommandFromToolCall({ tool: 'Bash', input: {} }),
        nonMutating: covenCode.helpers.filesModifiedByToolCall({ tool: 'Read', input: { path: 'README.md' } }),
      });
    },
  );
}
`);

  const result = runCovenCode(['plugins', 'run', 'inspect-null-helpers'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    nonShell: null,
    missingCommand: null,
    nonMutating: null,
  });
});

test('plugin toolCallsInMessages pairs tool uses with terminal results', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'tool-call-pairs.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'inspect-tool-call-pairs',
    {
      title: 'Inspect tool call pairs',
      category: 'runtime',
    },
    async () => {
      const pairs = covenCode.helpers.toolCallsInMessages([
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_pair',
            name: 'Bash',
            input: { command: 'printf paired' },
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            toolUseID: 'toolu_pair',
            output: 'paired',
            status: 'done',
          }],
        },
      ]);
      return JSON.stringify(pairs);
    },
  );
}
`);

  const result = runCovenCode(['plugins', 'run', 'inspect-tool-call-pairs'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [{
    call: {
      toolUseID: 'toolu_pair',
      tool: 'Bash',
      input: { command: 'printf paired' },
    },
    result: {
      toolUseID: 'toolu_pair',
      tool: 'Bash',
      input: { command: 'printf paired' },
      status: 'done',
      output: 'paired',
    },
  }]);
});

test('plugin helpers classify unavailable UI errors', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'ui-helper.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'classify-ui-errors',
    {
      title: 'Classify UI errors',
      category: 'runtime',
    },
    async () => {
      const noUi = Object.assign(new Error('No Plugin UI available in this context'), {
        name: 'PluginUINotAvailableError',
        code: 'PLUGIN_UI_NOT_AVAILABLE',
      });
      return JSON.stringify({
        noUi: covenCode.helpers.isPluginUINotAvailableError(noUi),
        generic: covenCode.helpers.isPluginUINotAvailableError(new Error('network unavailable')),
      });
    },
  );
}
`);

  const result = runCovenCode(['plugins', 'run', 'classify-ui-errors'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { noUi: true, generic: false });
});

test('built-in Bash git commits include Coven Code thread trailers by default', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# fixture\n');

  assert.equal(runGit(['init'], { cwd: workspace }).status, 0);
  assert.equal(runGit(['add', 'README.md'], { cwd: workspace }).status, 0);

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use Bash --command "git commit -m initial"',
    '--stream-json',
  ], {
    cwd: workspace,
    env: {
      XDG_CONFIG_HOME: xdg,
      HOME: home,
      GIT_AUTHOR_NAME: 'Coven Code Test',
      GIT_AUTHOR_EMAIL: 'coven-code-test@example.com',
      GIT_COMMITTER_NAME: 'Coven Code Test',
      GIT_COMMITTER_EMAIL: 'coven-code-test@example.com',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const threadId = JSON.parse(result.stdout.trim().split('\n').at(-1)).session_id;
  const log = runGit(['log', '-1', '--pretty=%B'], { cwd: workspace });
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, new RegExp(`Coven-Code-Thread: https://coven-code\\.local/threads/${threadId}`));
  assert.doesNotMatch(log.stdout, /Co-authored-by:/);
});

test('built-in Bash git commit trailers respect Coven Code git settings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.git.commit.thread.enabled': false,
    'covenCode.git.commit.coauthor.enabled': false,
  }));
  await writeFile(path.join(workspace, 'README.md'), '# fixture\n');

  assert.equal(runGit(['init'], { cwd: workspace }).status, 0);
  assert.equal(runGit(['add', 'README.md'], { cwd: workspace }).status, 0);

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use Bash --command "git commit -m initial"',
  ], {
    cwd: workspace,
    env: {
      XDG_CONFIG_HOME: xdg,
      HOME: home,
      GIT_AUTHOR_NAME: 'Coven Code Test',
      GIT_AUTHOR_EMAIL: 'coven-code-test@example.com',
      GIT_COMMITTER_NAME: 'Coven Code Test',
      GIT_COMMITTER_EMAIL: 'coven-code-test@example.com',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const log = runGit(['log', '-1', '--pretty=%B'], { cwd: workspace });
  assert.equal(log.status, 0, log.stderr);
  assert.doesNotMatch(log.stdout, /Coven-Code-Thread:/);
  assert.doesNotMatch(log.stdout, /Co-authored-by:/);
});

test('execute mode can invoke built-in Read with plugin lifecycle hooks', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'read-events.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, 'notes.md'), 'project codename: river-signal\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'read-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'Read') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'Read') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'result',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
      status: event.status,
      output: event.output,
    }) + '\\n');
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use Read --path notes.md'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'project codename: river-signal');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.match(events[0].threadId, /^T-/);
  assert.deepEqual(events[0], {
    type: 'call',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input: { path: 'notes.md' },
  });
  assert.deepEqual(events[1], {
    type: 'result',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input: { path: 'notes.md' },
    status: 'done',
    output: 'project codename: river-signal',
  });
});

test('plugin tool.result handlers can mark built-in Read results as errors', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, 'notes.md'), 'project codename: river-signal\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'read-result-error.ts'), `
export default function (covenCode) {
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'Read') {
      return { status: 'error', error: 'Read output rejected by plugin' };
    }
  });
}
`);

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use Read --path notes.md',
    '--stream-json',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const toolResult = messages.find((message) => message.message?.content?.[0]?.type === 'tool_result');
  assert.equal(toolResult.message.content[0].is_error, true);
  assert.equal(toolResult.message.content[0].content, 'Read output rejected by plugin');
  assert.equal(messages.at(-1).is_error, true);
  assert.equal(messages.at(-1).subtype, 'error_during_execution');
  assert.equal(messages.at(-1).error, 'Read output rejected by plugin');
});

test('execute mode can invoke built-in edit_file with plugin lifecycle hooks', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'edit-events.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, 'notes.md'), 'project codename: river-signal\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'edit-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'edit_file') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'edit_file') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'result',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
      status: event.status,
      output: event.output,
    }) + '\\n');
  });
}
`);

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use edit_file --path notes.md --old "river-signal" --new "orchid-signal"',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'Edited notes.md');
  assert.equal(await readFile(path.join(workspace, 'notes.md'), 'utf8'), 'project codename: orchid-signal\n');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const input = { path: 'notes.md', old: 'river-signal', new: 'orchid-signal', old_string: 'river-signal', new_string: 'orchid-signal' };
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.match(events[0].threadId, /^T-/);
  assert.deepEqual(events[0], {
    type: 'call',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
  });
  assert.deepEqual(events[1], {
    type: 'result',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
    status: 'done',
    output: 'Edited notes.md',
  });
});

test('plugin helpers report files modified by built-in edit_file calls', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'modified-files.json');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, 'notes.md'), 'project codename: river-signal\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'modified-files.ts'), `
import { writeFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool !== 'edit_file') return;
    const files = covenCode.helpers.filesModifiedByToolCall(event) ?? [];
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify(files.map((file) => ({
      uri: file.toString(),
      path: covenCode.helpers.filePathFromURI(file),
    }))));
  });
}
`);

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use edit_file --path notes.md --old "river-signal" --new "orchid-signal"',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const files = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(files.length, 1);
  assert.equal(path.basename(files[0].path), 'notes.md');
  assert.equal(files[0].uri, pathToFileURL(files[0].path).href);
});

test('plugin helpers report files modified by apply_patch and sed shell calls', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'modified-files.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'inspect-modified-files',
    {
      title: 'Inspect modified files',
      category: 'runtime',
    },
    async () => {
      const patchFiles = covenCode.helpers.filesModifiedByToolCall({
        tool: 'apply_patch',
        input: { patch: '*** Begin Patch\\n*** Update File: src/app.js\\n@@\\n-old\\n+new\\n*** End Patch\\n' },
      }) ?? [];
      const sedFiles = covenCode.helpers.filesModifiedByToolCall({
        tool: 'Bash',
        input: { command: "sed -i '' 's/old/new/' README.md" },
      }) ?? [];
      return JSON.stringify({
        patch: patchFiles.map((uri) => covenCode.helpers.filePathFromURI(uri)),
        sed: sedFiles.map((uri) => covenCode.helpers.filePathFromURI(uri)),
      });
    },
  );
}
`);

  const result = runCovenCode(['plugins', 'run', 'inspect-modified-files'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const realWorkspace = await realpath(workspace);
  assert.deepEqual(JSON.parse(result.stdout), {
    patch: [path.join(realWorkspace, 'src', 'app.js')],
    sed: [path.join(realWorkspace, 'README.md')],
  });
});

test('execute mode can undo the latest built-in edit_file change across a continued thread', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'undo-events.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, 'notes.md'), 'project codename: amber-signal\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'undo-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'undo_edit') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'undo_edit') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'result',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
      status: event.status,
      output: event.output,
    }) + '\\n');
  });
}
`);

  const edit = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use edit_file --path notes.md --old amber-signal --new jade-signal',
    '--stream-json',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(edit.status, 0, edit.stderr);
  assert.equal(await readFile(path.join(workspace, 'notes.md'), 'utf8'), 'project codename: jade-signal\n');
  const threadId = JSON.parse(edit.stdout.trim().split('\n').at(-1)).session_id;

  const undo = runCovenCode([
    '--dangerously-allow-all',
    '--continue',
    threadId,
    '--execute',
    'use undo_edit --path notes.md',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(undo.status, 0, undo.stderr);
  assert.equal(undo.stdout.trim(), 'Undid edit to notes.md');
  assert.equal(await readFile(path.join(workspace, 'notes.md'), 'utf8'), 'project codename: amber-signal\n');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const input = { path: 'notes.md' };
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.equal(events[0].threadId, threadId);
  assert.deepEqual(events[0], {
    type: 'call',
    toolUseID: events[0].toolUseID,
    threadId,
    input,
  });
  assert.deepEqual(events[1], {
    type: 'result',
    toolUseID: events[0].toolUseID,
    threadId,
    input,
    status: 'done',
    output: 'Undid edit to notes.md',
  });
});

test('removed todo tools are not exposed or executable', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const env = { XDG_CONFIG_HOME: xdg, HOME: home };

  const list = runCovenCode(['tools', 'list'], { env });
  assert.equal(list.status, 0, list.stderr);
  assert.doesNotMatch(list.stdout, /^todo_read\s+built-in/m);
  assert.doesNotMatch(list.stdout, /^todo_write\s+built-in/m);

  const result = runCovenCode(['--execute', 'use todo_read'], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Unknown tool: todo_read/);
});

test('execute mode can invoke built-in mermaid to emit a diagram block', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const env = { XDG_CONFIG_HOME: xdg, HOME: home };

  const list = runCovenCode(['tools', 'list'], { env });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^mermaid\s+built-in\s+Renders a Mermaid diagram/m);

  const result = runCovenCode([
    '--execute',
    'use mermaid --code "graph TD; A[CLI] --> B[Agent]"',
    '--stream-json',
  ], { env });
  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const toolUse = messages.find((message) => message.type === 'assistant' && message.message.content[0]?.type === 'tool_use')
    .message.content[0];
  assert.equal(toolUse.name, 'mermaid');
  assert.deepEqual(toolUse.input, { code: 'graph TD; A[CLI] --> B[Agent]' });
  assert.equal(messages.at(-1).result, '```mermaid\ngraph TD; A[CLI] --> B[Agent]\n```');
});

test('execute mode can invoke built-in create_file with plugin lifecycle hooks', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'create-events.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'create-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'create_file') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'create_file') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'result',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
      status: event.status,
      output: event.output,
    }) + '\\n');
  });
}
`);

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use create_file --path notes.md --content "project codename: amber-signal\\n"',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'Created notes.md');
  assert.equal(await readFile(path.join(workspace, 'notes.md'), 'utf8'), 'project codename: amber-signal\\n');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const input = { path: 'notes.md', content: 'project codename: amber-signal\\n' };
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.match(events[0].threadId, /^T-/);
  assert.deepEqual(events[0], {
    type: 'call',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
  });
  assert.deepEqual(events[1], {
    type: 'result',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
    status: 'done',
    output: 'Created notes.md',
  });
});

test('execute mode can invoke built-in Grep with plugin lifecycle hooks', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'grep-events.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await mkdir(path.join(workspace, 'docs'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, 'notes.md'), 'project codename: amber-signal\n');
  await writeFile(path.join(workspace, 'docs', 'plan.md'), 'no matching codename here\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'grep-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'Grep') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'Grep') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'result',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
      status: event.status,
      output: event.output,
    }) + '\\n');
  });
}
`);

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use Grep --pattern "codename: [a-z-]+$" --path .',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'notes.md:1:project codename: amber-signal');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const input = { pattern: 'codename: [a-z-]+$', path: '.' };
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.match(events[0].threadId, /^T-/);
  assert.deepEqual(events[0], {
    type: 'call',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
  });
  assert.deepEqual(events[1], {
    type: 'result',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
    status: 'done',
    output: 'notes.md:1:project codename: amber-signal',
  });
});

test('execute mode can invoke built-in glob with plugin lifecycle hooks', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'glob-events.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await mkdir(path.join(workspace, 'docs'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, 'README.md'), '# Fixture\n');
  await writeFile(path.join(workspace, 'docs', 'plan.md'), '# Plan\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'glob-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'glob') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'glob') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'result',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
      status: event.status,
      output: event.output,
    }) + '\\n');
  });
}
`);

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use glob --pattern "**/*.md" --path .',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'README.md\ndocs/plan.md');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const input = { pattern: '**/*.md', path: '.' };
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.match(events[0].threadId, /^T-/);
  assert.deepEqual(events[0], {
    type: 'call',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
  });
  assert.deepEqual(events[1], {
    type: 'result',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
    status: 'done',
    output: 'README.md\ndocs/plan.md',
  });
});

test('stream json emits Task subagent messages with parent tool ids', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'task-events.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'task-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'Task') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'Task') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'result',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
      status: event.status,
      output: event.output,
    }) + '\\n');
  });
}
`);

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use Task --description "math helper" --prompt "what is 2+2?"',
    '--stream-json',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.type), ['system', 'user', 'assistant', 'assistant', 'user', 'assistant', 'result']);
  const toolUse = messages[2].message.content[0];
  assert.equal(toolUse.type, 'tool_use');
  assert.equal(toolUse.name, 'Task');
  assert.deepEqual(toolUse.input, { description: 'math helper', prompt: 'what is 2+2?' });
  assert.equal(messages[3].parent_tool_use_id, toolUse.id);
  assert.equal(messages[3].message.content[0].text, '4');
  assert.equal(messages[4].parent_tool_use_id, null);
  assert.equal(messages[4].message.content[0].tool_use_id, toolUse.id);
  assert.equal(messages[5].parent_tool_use_id, null);
  assert.equal(messages[5].message.content[0].text, '4');
  assert.equal(messages[6].result, '4');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const input = { description: 'math helper', prompt: 'what is 2+2?' };
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.equal(events[0].toolUseID, toolUse.id);
  assert.equal(events[0].threadId, messages[0].session_id);
  assert.deepEqual(events[0], {
    type: 'call',
    toolUseID: toolUse.id,
    threadId: messages[0].session_id,
    input,
  });
  assert.deepEqual(events[1], {
    type: 'result',
    toolUseID: toolUse.id,
    threadId: messages[0].session_id,
    input,
    status: 'done',
    output: '4',
  });
});

test('execute mode can invoke built-in oracle with plugin lifecycle hooks', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'oracle-events.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'oracle-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'oracle') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'oracle') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'result',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
      status: event.status,
      output: event.output,
    }) + '\\n');
  });
}
`);

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use oracle --prompt "what is 2+2?"',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'Oracle: 4');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const input = { prompt: 'what is 2+2?' };
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.match(events[0].threadId, /^T-/);
  assert.deepEqual(events[0], {
    type: 'call',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
  });
  assert.deepEqual(events[1], {
    type: 'result',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
    status: 'done',
    output: 'Oracle: 4',
  });
});

test('execute mode can invoke built-in librarian to research workspace code', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src', 'validation.ts'), 'export const note = "zod validation path";\n');

  const result = runCovenCode([
    '--execute',
    'use librarian --query "zod validation"',
    '--stream-json',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(messages[0].tools.includes('librarian'));
  assert.equal(messages.at(-1).result, [
    'Librarian search: zod validation',
    'scope: current workspace',
    'matches:',
    '- src/validation.ts:1: export const note = "zod validation path";',
  ].join('\n'));
});

test('execute mode can invoke built-in painter to generate a local image artifact', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(workspace, { recursive: true });

  const result = runCovenCode([
    '--execute',
    'use painter --prompt "dark terminal icon with cyan cursor" --output assets/icon.png',
    '--stream-json',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(messages[0].tools.includes('painter'));
  assert.equal(messages.at(-1).result, [
    'Generated image: assets/icon.png',
    'media_type: image/png',
    'prompt: dark terminal icon with cyan cursor',
  ].join('\n'));
  const image = await readFile(path.join(workspace, 'assets', 'icon.png'));
  assert.deepEqual([...image.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('execute mode can invoke built-in look_at to inspect a local media file', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, 'images'), { recursive: true });
  await writeFile(path.join(workspace, 'images', 'sample.png'), Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
  ]));

  const result = runCovenCode([
    '--execute',
    'use look_at --path images/sample.png --goal "identify media type"',
    '--stream-json',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(messages[0].tools.includes('look_at'));
  assert.equal(messages.at(-1).result, [
    'Looked at: images/sample.png',
    'media_type: image/png',
    'bytes: 12',
    'goal: identify media type',
  ].join('\n'));
});

test('execute mode can invoke built-in web_search with plugin lifecycle hooks', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'web-search-events.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'web-search-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'web_search') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'web_search') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'result',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
      status: event.status,
      output: event.output,
    }) + '\\n');
  });
}
`);

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use web_search --query "covenCode manual" --limit 1',
  ], {
    cwd: workspace,
    env: {
      XDG_CONFIG_HOME: xdg,
      HOME: home,
      COVEN_CODE_WEB_SEARCH_RESULTS_JSON: JSON.stringify([
        { title: 'Coven Code Owner Manual', url: 'https://coven-code.com/manual', snippet: 'Coven Code CLI documentation' },
      ]),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1. Coven Code Owner Manual\nhttps://coven-code.com/manual\nCoven Code CLI documentation');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const input = { query: 'covenCode manual', limit: 1 };
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.match(events[0].threadId, /^T-/);
  assert.deepEqual(events[0], {
    type: 'call',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
  });
  assert.deepEqual(events[1], {
    type: 'result',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
    status: 'done',
    output: '1. Coven Code Owner Manual\nhttps://coven-code.com/manual\nCoven Code CLI documentation',
  });
});

test('execute mode can invoke built-in read_web_page with plugin lifecycle hooks', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'read-web-page-events.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'read-web-page-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'read_web_page') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'read_web_page') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'result',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
      status: event.status,
      output: event.output,
    }) + '\\n');
  });
}
`);

  const url = 'data:text/html,%3Cmain%3E%3Ch1%3ECoven%20Code%20Manual%3C%2Fh1%3E%3Cp%3ECLI%20docs%20and%20tools.%3C%2Fp%3E%3C%2Fmain%3E';
  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    `use read_web_page --url ${url}`,
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'Coven Code Manual\nCLI docs and tools.');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const input = { url };
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.match(events[0].threadId, /^T-/);
  assert.deepEqual(events[0], {
    type: 'call',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
  });
  assert.deepEqual(events[1], {
    type: 'result',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
    status: 'done',
    output: 'Coven Code Manual\nCLI docs and tools.',
  });
});

test('execute mode can invoke built-in finder to search prior threads', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'finder-events.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'finder-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'finder') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'finder') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'result',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
      status: event.status,
      output: event.output,
    }) + '\\n');
  });
}
`);

  const first = runCovenCode(['--execute', 'remember the amber-signal release plan', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(first.status, 0, first.stderr);
  const firstThreadId = JSON.parse(first.stdout.trim().split('\n').at(-1)).session_id;

  const second = runCovenCode(['--execute', 'remember the jade-signal migration plan', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(second.status, 0, second.stderr);
  const secondThreadId = JSON.parse(second.stdout.trim().split('\n').at(-1)).session_id;

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use finder --query amber-signal --limit 3',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${firstThreadId}\\s+active\\s+private\\s+-\\s+remember the amber-signal release plan`));
  assert.doesNotMatch(result.stdout, new RegExp(secondThreadId));
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const input = { query: 'amber-signal', limit: 3 };
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.match(events[0].threadId, /^T-/);
  assert.deepEqual(events[0], {
    type: 'call',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
  });
  assert.equal(events[1].type, 'result');
  assert.equal(events[1].toolUseID, events[0].toolUseID);
  assert.equal(events[1].threadId, events[0].threadId);
  assert.deepEqual(events[1].input, input);
  assert.match(events[1].output, new RegExp(firstThreadId));
  assert.equal(events[1].status, 'done');
});

test('execute mode can invoke built-in find_thread to search prior threads', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const first = runCovenCode(['--execute', 'remember the amber-signal release plan', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(first.status, 0, first.stderr);
  const firstThreadId = JSON.parse(first.stdout.trim().split('\n').at(-1)).session_id;

  const second = runCovenCode(['--execute', 'remember the jade-signal migration plan', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(second.status, 0, second.stderr);
  const secondThreadId = JSON.parse(second.stdout.trim().split('\n').at(-1)).session_id;

  const result = runCovenCode(['--execute', 'use find_thread --query amber-signal --limit 3'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${firstThreadId}\\s+active\\s+private\\s+-\\s+remember the amber-signal release plan`));
  assert.doesNotMatch(result.stdout, new RegExp(secondThreadId));
});

test('plugin agent.start handlers run when execute mode starts a turn', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'agent-start.json');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'agent-start.ts'), `
import { writeFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('agent.start', async (event) => {
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
      message: event.message,
      threadId: event.thread.id,
    }));
  });
}
`);

  const result = runCovenCode(['--execute', 'hello lifecycle'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const event = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(event.message, 'hello lifecycle');
  assert.match(event.threadId, /^T-/);
});

test('plugin agent.start handlers can append context to the user message', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'agent-start-context.ts'), `
export default function (covenCode) {
  covenCode.on('agent.start', async () => {
    return {
      message: {
        content: 'codename: plugin-orchid',
        display: true,
      },
    };
  });
}
`);

  const result = runCovenCode(['--execute', 'what codename did the plugin add?'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'plugin-orchid');
});

test('plugin agent.start message content must be a string', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-agent-start.ts'), `
export default function (covenCode) {
  covenCode.on('agent.start', async () => {
    return {
      message: {
        content: { text: 'not allowed' },
        display: true,
      },
    };
  });
}
`);

  const result = runCovenCode(['--execute', 'what is 2+2?'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin agent.start message content must be a string/);
});

test('plugin agent.start message display must be true', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-agent-start.ts'), `
export default function (covenCode) {
  covenCode.on('agent.start', async () => {
    return {
      message: {
        content: 'codename: should-not-append',
        display: false,
      },
    };
  });
}
`);

  const result = runCovenCode(['--execute', 'what codename did the plugin add?'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin agent.start message display must be true/);
});

test('plugin agent.start message rejects fields outside the documented shape', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-agent-start.ts'), `
export default function (covenCode) {
  covenCode.on('agent.start', async () => {
    return {
      message: {
        content: 'codename: should-not-append',
        display: true,
        transient: true,
      },
    };
  });
}
`);

  const result = runCovenCode(['--execute', 'what codename did the plugin add?'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin agent.start message fields must be content and display/);
});

test('plugin request event handlers continue after one returns a result', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'agent-start-handlers.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'a-agent-start-context.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('agent.start', async () => {
    appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ plugin: 'a' }) + '\\n');
    return {
      message: {
        content: 'codename: multi-handler-orchid',
        display: true,
      },
    };
  });
}
`);
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'b-agent-start-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('agent.start', async (event) => {
    appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ plugin: 'b', message: event.message }) + '\\n');
  });
}
`);

  const result = runCovenCode(['--execute', 'what codename did the plugin add?'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'multi-handler-orchid');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events, [
    { plugin: 'a' },
    { plugin: 'b', message: 'what codename did the plugin add?' },
  ]);
});

test('plugin agent.start appended context applies to stream-json input turns', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'agent-start-context.ts'), `
export default function (covenCode) {
  covenCode.on('agent.start', async () => {
    return {
      message: {
        content: 'codename: stream-orchid',
        display: true,
      },
    };
  });
}
`);
  const input = `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'what codename did the stream plugin add?' }],
    },
  })}\n`;

  const result = runCovenCode(['--execute', '--stream-json', '--stream-json-input'], {
    cwd: workspace,
    input,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(messages.at(-1).result, 'stream-orchid');
});

test('plugin event context exposes logger shell system and thread helpers', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'agent-start-context.json');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'agent-start-context.ts'), `
import { writeFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('agent.start', async (event, ctx) => {
    ctx.logger.log('agent.start context observed');
    const notifyResult = ctx.ui.notify('agent.start context notification');
    const pwd = await ctx.$\`pwd\`;
    await ctx.system.open('https://coven-code.com/manual/plugin-api');
    await ctx.thread.append([{ type: 'user-message', content: 'event context note' }]);
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
      eventThreadId: event.thread.id,
      ctxThreadId: ctx.thread.id,
      loggerKeys: Object.keys(ctx.logger).sort(),
      notifyIsPromise: typeof notifyResult?.then === 'function',
      pwd: pwd.stdout.trim(),
      exitCode: pwd.exitCode,
      executor: ctx.system.executor.kind,
      covenCodeURL: String(ctx.system.covenCodeURL),
    }));
  });
}
`);

  const result = runCovenCode(['--execute', 'hello plugin context', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const threadId = JSON.parse(result.stdout.trim().split('\n').at(-1)).session_id;
  const event = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(event.eventThreadId, threadId);
  assert.equal(event.ctxThreadId, threadId);
  assert.deepEqual(event.loggerKeys, ['log']);
  assert.equal(event.notifyIsPromise, true);
  assert.match(event.pwd, /\/repo$/);
  assert.equal(event.exitCode, 0);
  assert.equal(event.executor, 'local');
  assert.equal(event.covenCodeURL, 'https://coven-code.local/');

  const show = runCovenCode(['threads', 'show', threadId], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /user: event context note/);
});

test('plugin session.start runs before agent.start with the thread id', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'plugin-events.json');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'session-start.ts'), `
import { writeFileSync } from 'node:fs';

const events = [];
function record(event) {
  events.push(event);
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify(events));
}

export default function (covenCode) {
  covenCode.on('session.start', async (event) => {
    record({ type: 'session.start', threadId: event.thread.id });
  });
  covenCode.on('agent.start', async (event) => {
    record({ type: 'agent.start', threadId: event.thread.id, message: event.message });
  });
}
`);

  const result = runCovenCode(['--execute', 'hello lifecycle'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const events = JSON.parse(await readFile(marker, 'utf8'));
  assert.deepEqual(events.map((event) => event.type), ['session.start', 'agent.start']);
  assert.match(events[0].threadId, /^T-/);
  assert.equal(events[1].threadId, events[0].threadId);
  assert.equal(events[1].message, 'hello lifecycle');
});

test('plugin agent.end handlers run with the execute-mode result', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'agent-end.json');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'agent-end.ts'), `
import { writeFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('agent.end', async (event) => {
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
      message: event.message,
      result: event.result,
      threadId: event.thread.id,
    }));
  });
}
`);

  const result = runCovenCode(['--execute', 'what is 2+2?'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const event = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(event.message, 'what is 2+2?');
  assert.equal(event.result, '4');
  assert.match(event.threadId, /^T-/);
});

test('plugin agent.start and agent.end expose the triggering message id', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'agent-message-ids.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'agent-message-ids.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  function record(event) {
    appendFileSync(${JSON.stringify(marker)}, JSON.stringify(event) + '\\n');
  }
  covenCode.on('agent.start', async (event) => {
    record({ type: 'agent.start', id: event.id, message: event.message, threadId: event.thread.id });
  });
  covenCode.on('agent.end', async (event) => {
    record({ type: 'agent.end', id: event.id, message: event.message, threadId: event.thread.id });
  });
}
`);

  const result = runCovenCode(['--execute', 'what is 2+2?'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ['agent.start', 'agent.end']);
  assert.match(events[0].id, /^msg_/);
  assert.equal(events[1].id, events[0].id);
  assert.equal(events[0].message, 'what is 2+2?');
  assert.equal(events[1].message, 'what is 2+2?');
  assert.equal(events[1].threadId, events[0].threadId);
});

test('plugin agent.end messages use thread content block shape', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'agent-message-shape.json');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'agent-message-shape.ts'), `
import { writeFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('agent.end', async (event) => {
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify(event.messages));
  });
}
`);

  const result = runCovenCode(['--execute', 'what is 2+2?'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = JSON.parse(await readFile(marker, 'utf8'));
  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant']);
  assert.match(messages[0].id, /^msg_/);
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'what is 2+2?' }]);
  assert.match(messages[1].id, /^msg_/);
  assert.deepEqual(messages[1].content, [{ type: 'text', text: '4' }]);
});

test('plugin agent.end exposes turn messages for toolCallsInMessages helper', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'agent-end-tool-calls.json');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'agent-end-tool-calls.ts'), `
import { writeFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('agent.end', async (event) => {
    const toolCalls = covenCode.helpers.toolCallsInMessages(event.messages ?? []);
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
      status: event.status,
      messageCount: event.messages?.length ?? 0,
      toolCalls: toolCalls.map((pair) => ({
        toolUseID: pair.call.toolUseID,
        tool: pair.call.tool,
        input: pair.call.input,
        resultStatus: pair.result.status,
        resultOutput: pair.result.output,
      })),
    }));
  });
}
`);

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use Bash --command "printf helper-tool-call"'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'helper-tool-call');
  const event = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(event.status, 'done');
  assert.ok(event.messageCount >= 3);
  assert.equal(event.toolCalls.length, 1);
  assert.match(event.toolCalls[0].toolUseID, /^toolu_/);
  assert.equal(event.toolCalls[0].tool, 'Bash');
  assert.deepEqual(event.toolCalls[0].input, { command: 'printf helper-tool-call', cmd: 'printf helper-tool-call' });
  assert.equal(event.toolCalls[0].resultStatus, 'done');
  assert.equal(event.toolCalls[0].resultOutput, 'helper-tool-call');
});

test('plugin agent.end handlers can continue execute mode with a follow-up user message', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'agent-end-events.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'agent-end-continue.ts'), `
import { appendFileSync } from 'node:fs';

const marker = '[plugin:tests-requested]';

export default function (covenCode) {
  function record(event) {
    appendFileSync(${JSON.stringify(marker)}, JSON.stringify(event) + '\\n');
  }
  covenCode.on('agent.start', async (event) => {
    record({ type: 'agent.start', message: event.message, threadId: event.thread.id });
  });
  covenCode.on('agent.end', async (event) => {
    record({ type: 'agent.end', message: event.message, result: event.result, threadId: event.thread.id });
    if (event.message.toLowerCase().includes('verify') && !event.message.includes(marker)) {
      return { action: 'continue', userMessage: marker + ' what is 2+2?' };
    }
  });
}
`);

  const result = runCovenCode(['--execute', 'verify this answer'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '4');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => [event.type, event.message]), [
    ['agent.start', 'verify this answer'],
    ['agent.end', 'verify this answer'],
    ['agent.start', '[plugin:tests-requested] what is 2+2?'],
    ['agent.end', '[plugin:tests-requested] what is 2+2?'],
  ]);
  assert.equal(new Set(events.map((event) => event.threadId)).size, 1);
});

test('stream json emits error_max_turns when agent.end continuations exceed the cap', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'agent-end-continue-forever.ts'), `
export default function (covenCode) {
  covenCode.on('agent.end', async () => {
    return { action: 'continue', userMessage: 'what is 2+2?' };
  });
}
`);

  const result = runCovenCode(['--execute', 'start loop', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const final = messages.at(-1);
  assert.equal(final.type, 'result');
  assert.equal(final.subtype, 'error_max_turns');
  assert.equal(final.is_error, true);
  assert.equal(final.num_turns, 9);
  assert.match(final.error, /maximum agent continuation turns exceeded/i);
  assert.equal(Object.hasOwn(final, 'result'), false);
});

test('plugin agent.end continuation actions must be continue', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-agent-end.ts'), `
export default function (covenCode) {
  covenCode.on('agent.end', async () => {
    return { action: 'pause', userMessage: 'ignored' };
  });
}
`);

  const result = runCovenCode(['--execute', 'what is 2+2?'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin agent.end action must be continue/);
});

test('plugin agent.end continue userMessage must be a string', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-agent-end.ts'), `
export default function (covenCode) {
  covenCode.on('agent.end', async () => {
    return { action: 'continue', userMessage: { text: 'not allowed' } };
  });
}
`);

  const result = runCovenCode(['--execute', 'what is 2+2?'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin agent.end continue userMessage must be a string/);
});

test('plugins commands lists and runs registered commands', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'commands.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'open-plugin-docs',
    {
      title: 'Open plugin docs',
      category: 'docs',
      description: 'Open the Coven Code Plugin API manual page.',
    },
    async (ctx) => {
      ctx.ui.notify('opened plugin docs');
    },
  );
}
`);

  const list = runCovenCode(['plugins', 'commands'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /open-plugin-docs\s+enabled\s+docs\s+Open plugin docs\s+Open the Coven Code Plugin API manual page\./);

  const run = runCovenCode(['plugins', 'run', 'open-plugin-docs'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /opened plugin docs/);
});

test('plugin root logger matches documented surface', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'logger.ts'), `
let loggerKeys = [];

export default function (covenCode) {
  loggerKeys = Object.keys(covenCode.logger).sort();
  covenCode.registerCommand(
    'inspect-root-logger',
    { title: 'Inspect root logger' },
    async () => JSON.stringify(loggerKeys),
  );
}
`);

  const result = runCovenCode(['plugins', 'run', 'inspect-root-logger'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), ['log']);
});

test('plugin subscriptions match documented surfaces', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'subscriptions.ts'), `
let shapes = {};

export default function (covenCode) {
  const tool = covenCode.registerTool({
    name: 'subscription_probe',
    description: 'Inspect subscription shape',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'ok';
    },
  });
  const event = covenCode.on('agent.start', async () => {});
  const configuration = covenCode.configuration.subscribe(() => {});
  const status = covenCode.experimental.createStatusItem({ text: 'ready' });
  const activeThread = covenCode.experimental.activeThread.subscribe(() => {});
  const command = covenCode.registerCommand(
    'inspect-subscriptions',
    { title: 'Inspect subscriptions' },
    async () => JSON.stringify(shapes),
  );

  shapes = {
    tool: Object.keys(tool).sort(),
    event: Object.keys(event).sort(),
    configuration: Object.keys(configuration).sort(),
    status: Object.keys(status).sort(),
    activeThread: Object.keys(activeThread).sort(),
    command: Object.keys(command).sort(),
  };
}
`);

  const result = runCovenCode(['plugins', 'run', 'inspect-subscriptions'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    tool: ['unsubscribe'],
    event: ['unsubscribe'],
    configuration: ['unsubscribe'],
    status: ['unsubscribe', 'update'],
    activeThread: ['unsubscribe'],
    command: ['setAvailability', 'unsubscribe'],
  });
});

test('plugin command registration subscriptions can unsubscribe', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'commands.ts'), `
export default function (covenCode) {
  const subscription = covenCode.registerCommand(
    'temporary-command',
    { title: 'Temporary command', category: 'ops' },
    async () => 'temporary',
  );
  subscription.unsubscribe();
  covenCode.registerCommand(
    'permanent-command',
    { title: 'Permanent command', category: 'ops' },
    async () => 'permanent',
  );
}
`);

  const commands = runCovenCode(['plugins', 'commands'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  const plugins = runCovenCode(['plugins', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(commands.status, 0, commands.stderr);
  assert.match(commands.stdout, /permanent-command\s+enabled\s+ops\s+Permanent command/);
  assert.doesNotMatch(commands.stdout, /temporary-command/);
  assert.equal(plugins.status, 0, plugins.stderr);
  assert.match(plugins.stdout, /commands\s+project\s+tools=-\s+commands=permanent-command\s+events=-/);
  assert.doesNotMatch(plugins.stdout, /temporary-command/);
});

test('plugin command category defaults to the plugin name', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'workspace-actions.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'refresh-index',
    {
      title: 'Refresh index',
      description: 'Refresh the workspace index.',
    },
    async () => 'refreshed',
  );
}
`);

  const list = runCovenCode(['plugins', 'commands'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /refresh-index\s+enabled\s+workspace-actions\s+Refresh index\s+Refresh the workspace index\./);
});

test('plugin command options require a title', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-command.ts'), `
export default function (covenCode) {
  covenCode.registerCommand('missing-title', {}, async () => 'should not register');
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin command title is required: missing-title/);
});

test('plugin command category must be a string when present', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-command-category.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'invalid-category',
    { title: 'Invalid category', category: { label: 'workspace' } },
    async () => 'should not register',
  );
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin command category must be a string: invalid-category/);
});

test('plugin command description must be a string when present', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-command-description.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'invalid-description',
    { title: 'Invalid description', description: ['not allowed'] },
    async () => 'should not register',
  );
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin command description must be a string: invalid-description/);
});

test('plugin root API can show notifications during load', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'root-ui.ts'), `
export default function (covenCode) {
  const rootNotify = covenCode.ui.notify('plugin loaded');
  const rootNotifyIsPromise = typeof rootNotify?.then === 'function';
  covenCode.registerCommand(
    'run-root-ui',
    {
      title: 'Run root UI',
      category: 'root-ui',
      description: 'Show a command notification.',
    },
    async (ctx) => {
      const commandNotify = ctx.ui.notify('command ran');
      return JSON.stringify({
        rootNotifyIsPromise,
        commandNotifyIsPromise: typeof commandNotify?.then === 'function',
      });
    },
  );
}
`);

  const run = runCovenCode(['plugins', 'run', 'run-root-ui'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim().split('\n')[0]), {
    rootNotifyIsPromise: true,
    commandNotifyIsPromise: true,
  });
  assert.match(run.stdout, /plugin loaded/);
  assert.match(run.stdout, /command ran/);
});

test('plugin command context can prompt and append to the current thread', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'notes.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'add-note-to-thread',
    {
      title: 'Add note to thread',
      category: 'notes',
      description: 'Prompt for a note and append it to the current thread.',
    },
    async (ctx) => {
      const note = await ctx.ui.input({
        title: 'Thread note',
        helpText: 'What should Coven Code remember in this thread?',
        submitButtonText: 'Add note',
      });
      if (!note) return;
      await ctx.thread?.append([{ type: 'user-message', content: note }]);
      await ctx.ui.notify('note added');
    },
  );
}
`);

  const created = runCovenCode(['--execute', 'remember the first note', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(created.status, 0, created.stderr);
  const threadId = JSON.parse(created.stdout.trim().split('\n').at(-1)).session_id;

  const run = runCovenCode(['plugins', 'run', 'add-note-to-thread'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_PLUGIN_INPUT: 'manual follow-up note' },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /note added/);

  const show = runCovenCode(['threads', 'show', threadId], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /user: manual follow-up note/);
});

test('plugin thread append only accepts user-message entries', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'notes.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'append-assistant-message',
    { title: 'Append assistant message', category: 'notes' },
    async (ctx) => {
      await ctx.thread?.append([{ type: 'assistant-message', content: 'not allowed' }]);
    },
  );
}
`);

  const created = runCovenCode(['--execute', 'create an active thread', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(created.status, 0, created.stderr);

  const run = runCovenCode(['plugins', 'run', 'append-assistant-message'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /plugin thread append only supports user-message entries/);
});

test('plugin thread append requires string content', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'notes.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'append-object-content',
    { title: 'Append object content', category: 'notes' },
    async (ctx) => {
      await ctx.thread?.append([{ type: 'user-message', content: { text: 'not allowed' } }]);
    },
  );
}
`);

  const created = runCovenCode(['--execute', 'create an active thread', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(created.status, 0, created.stderr);

  const run = runCovenCode(['plugins', 'run', 'append-object-content'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /plugin thread append content must be a string/);
});

test('plugin command context supports input select and confirm UI flow', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'kitchen-sink.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'run-kitchen-sink-ui',
    {
      title: 'Run kitchen sink UI',
      category: 'kitchen-sink',
      description: 'Run notify, input, select, and confirm dialogs in sequence.',
    },
    async (ctx) => {
      await ctx.ui.notify('Starting the kitchen sink UI sequence.');
      const note = await ctx.ui.input({
        title: 'Kitchen sink input',
        helpText: 'Enter a note to append to the current thread.',
        initialValue: 'Hello from the kitchen sink plugin.',
        submitButtonText: 'Continue',
      });
      const choice = await ctx.ui.select({
        title: 'Kitchen sink select',
        message: 'Choose what to do with the note.',
        options: ['Append to thread', 'Show notification only', 'Cancel'],
      });
      const confirmed = await ctx.ui.confirm({
        title: 'Finish kitchen sink UI?',
        message: 'Choice: ' + (choice ?? '(cancelled)'),
        confirmButtonText: 'Finish',
      });
      if (confirmed && choice === 'Append to thread' && note) {
        await ctx.thread?.append([{ type: 'user-message', content: note }]);
      }
      await ctx.ui.notify(confirmed ? 'Kitchen sink UI finished.' : 'Kitchen sink UI cancelled.');
    },
  );
}
`);

  const created = runCovenCode(['--execute', 'seed kitchen sink thread', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(created.status, 0, created.stderr);
  const threadId = JSON.parse(created.stdout.trim().split('\n').at(-1)).session_id;

  const run = runCovenCode(['plugins', 'run', 'run-kitchen-sink-ui'], {
    cwd: workspace,
    env: {
      XDG_CONFIG_HOME: xdg,
      HOME: home,
      COVEN_CODE_PLUGIN_INPUT: 'kitchen sink selected note',
      COVEN_CODE_PLUGIN_SELECT: 'Append to thread',
      COVEN_CODE_PLUGIN_CONFIRM: 'true',
    },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Starting the kitchen sink UI sequence\./);
  assert.match(run.stdout, /Kitchen sink UI finished\./);

  const show = runCovenCode(['threads', 'show', threadId], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /user: kitchen sink selected note/);
});

test('plugin confirm options require a title', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-ui.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'confirm-without-title',
    { title: 'Confirm without title', category: 'ui' },
    async (ctx) => {
      await ctx.ui.confirm({ message: 'Missing title.' });
    },
  );
}
`);

  const run = runCovenCode(['plugins', 'run', 'confirm-without-title'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_PLUGIN_CONFIRM: 'true' },
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /plugin confirm title is required/);
});

test('plugin confirm requires an options object', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-ui.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'confirm-without-options',
    { title: 'Confirm without options', category: 'ui' },
    async (ctx) => {
      await ctx.ui.confirm();
    },
  );
}
`);

  const run = runCovenCode(['plugins', 'run', 'confirm-without-options'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_PLUGIN_CONFIRM: 'true' },
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /plugin confirm options must be an object/);
});

test('plugin confirm option values must be strings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-ui.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'confirm-object-message',
    { title: 'Confirm object message', category: 'ui' },
    async (ctx) => {
      await ctx.ui.confirm({
        title: 'Confirm',
        message: { text: 'not allowed' },
      });
    },
  );
}
`);

  const run = runCovenCode(['plugins', 'run', 'confirm-object-message'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_PLUGIN_CONFIRM: 'true' },
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /plugin confirm message must be a string/);
});

test('plugin select options require a title', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-ui.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'select-without-title',
    { title: 'Select without title', category: 'ui' },
    async (ctx) => {
      await ctx.ui.select({ options: ['one', 'two'] });
    },
  );
}
`);

  const run = runCovenCode(['plugins', 'run', 'select-without-title'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_PLUGIN_SELECT: 'one' },
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /plugin select title is required/);
});

test('plugin select requires an options object', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-ui.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'select-without-options',
    { title: 'Select without options', category: 'ui' },
    async (ctx) => {
      await ctx.ui.select();
    },
  );
}
`);

  const run = runCovenCode(['plugins', 'run', 'select-without-options'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_PLUGIN_SELECT: 'one' },
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /plugin select options must be an object/);
});

test('plugin select options must be strings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-ui.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'select-object-option',
    { title: 'Select object option', category: 'ui' },
    async (ctx) => {
      await ctx.ui.select({
        title: 'Choose',
        options: [{ label: 'One', value: 'one' }],
      });
    },
  );
}
`);

  const run = runCovenCode(['plugins', 'run', 'select-object-option'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_PLUGIN_SELECT: 'one' },
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /plugin select options must be strings/);
});

test('plugin select option values must be strings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-ui.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'select-object-initial-value',
    { title: 'Select object initial value', category: 'ui' },
    async (ctx) => {
      await ctx.ui.select({
        title: 'Choose',
        options: ['one', 'two'],
        initialValue: { value: 'one' },
      });
    },
  );
}
`);

  const run = runCovenCode(['plugins', 'run', 'select-object-initial-value'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_PLUGIN_SELECT: 'one' },
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /plugin select initialValue must be a string/);
});

test('plugin notify requires a string message', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-ui.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'notify-object',
    { title: 'Notify object', category: 'ui' },
    async (ctx) => {
      await ctx.ui.notify({ text: 'not allowed' });
    },
  );
}
`);

  const run = runCovenCode(['plugins', 'run', 'notify-object'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /plugin notify message must be a string/);
});

test('plugin input option values must be strings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-ui.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'input-object-default',
    { title: 'Input object default', category: 'ui' },
    async (ctx) => {
      await ctx.ui.input({ initialValue: { text: 'not allowed' } });
    },
  );
}
`);

  const run = runCovenCode(['plugins', 'run', 'input-object-default'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /plugin input initialValue must be a string/);
});

test('plugin input requires an options object', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-ui.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'input-without-options',
    { title: 'Input without options', category: 'ui' },
    async (ctx) => {
      await ctx.ui.input();
    },
  );
}
`);

  const run = runCovenCode(['plugins', 'run', 'input-without-options'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /plugin input options must be an object/);
});

test('plugin command input uses initialValue when noninteractive input is unset', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'input-default.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'show-input-default',
    {
      title: 'Show input default',
      category: 'kitchen-sink',
    },
    async (ctx) => {
      return await ctx.ui.input({
        title: 'Default branch name',
        initialValue: 'feature/default-branch',
      });
    },
  );
}
`);

  const run = runCovenCode(['plugins', 'run', 'show-input-default'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_PLUGIN_INPUT: '' },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'feature/default-branch');
});

test('plugin commands can inspect Coven Code system runtime metadata', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'runtime.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'show-kitchen-sink-runtime',
    {
      title: 'Show kitchen sink runtime',
      category: 'kitchen-sink',
      description: 'Show configuration, shell, and system information.',
    },
    async (ctx) => {
      const pwd = await covenCode.$\`pwd\`;
      await covenCode.system.open('https://coven-code.local/manual/plugin-api');
      await ctx.ui.notify([
        'Coven Code URL: ' + covenCode.system.covenCodeURL,
        'Executor: ' + covenCode.system.executor.kind,
        'Working directory: ' + pwd.stdout.trim(),
      ].join('\\n'));
    },
  );
}
`);

  const run = runCovenCode(['plugins', 'run', 'show-kitchen-sink-runtime'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /https:\/\/coven-code\.local\/manual\/plugin-api/);
  assert.match(run.stdout, /Coven Code URL: https:\/\/coven-code\.local/);
  assert.match(run.stdout, /Executor: local/);
  assert.match(run.stdout, /Working directory: .*\/repo/);
});

test('plugin system executor kind matches the documented local runtime', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'executor-kind.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'show-executor-kind',
    {
      title: 'Show executor kind',
      category: 'runtime',
    },
    async () => covenCode.system.executor.kind,
  );
}
`);

  const run = runCovenCode(['plugins', 'run', 'show-executor-kind'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'local');
});

test('plugin system covenCodeURL is a URL object and reflects COVEN_CODE_URL', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'system-url.json');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'system-url.ts'), `
import { writeFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.registerCommand(
    'inspect-system-url',
    {
      title: 'Inspect system URL',
      category: 'runtime',
    },
    async (ctx) => {
      return JSON.stringify({
        rootIsURL: covenCode.system.covenCodeURL instanceof URL,
        rootHref: covenCode.system.covenCodeURL.href,
        ctxIsURL: ctx.system.covenCodeURL instanceof URL,
        ctxHref: ctx.system.covenCodeURL.href,
      });
    },
  );
  covenCode.on('agent.start', async (_event, ctx) => {
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
      ctxIsURL: ctx.system.covenCodeURL instanceof URL,
      ctxHref: ctx.system.covenCodeURL.href,
    }));
  });
}
`);

  const run = runCovenCode(['plugins', 'run', 'inspect-system-url'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_URL: 'https://coven-code.local.test/base' },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    rootIsURL: true,
    rootHref: 'https://coven-code.local.test/base',
    ctxIsURL: true,
    ctxHref: 'https://coven-code.local.test/base',
  });

  const execute = runCovenCode(['--execute', 'inspect plugin system url'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_URL: 'https://coven-code.local.test/base' },
  });

  assert.equal(execute.status, 0, execute.stderr);
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
    ctxIsURL: true,
    ctxHref: 'https://coven-code.local.test/base',
  });
});

test('plugin system open target must be a string or URL', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-system.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'open-object-target',
    {
      title: 'Open object target',
      category: 'runtime',
    },
    async () => {
      await covenCode.system.open({ href: 'https://coven-code.com/manual/plugin-api' });
    },
  );
}
`);

  const result = runCovenCode(['plugins', 'run', 'open-object-target'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin system open target must be a string or URL/);
});

test('plugins commands honors disabled and hidden command availability', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'commands.ts'), `
export default function (covenCode) {
  const disabled = covenCode.registerCommand(
    'deploy-prod',
    {
      title: 'Deploy production',
      category: 'ops',
      description: 'Deploys the production service.',
    },
    async () => 'deployed',
  );
  disabled.setAvailability({ type: 'disabled', reason: 'Maintenance window' });

  const hidden = covenCode.registerCommand(
    'internal-toggle',
    {
      title: 'Internal toggle',
      category: 'ops',
    },
    async () => 'hidden',
  );
  hidden.setAvailability({ type: 'hidden' });
}
`);

  const list = runCovenCode(['plugins', 'commands'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /deploy-prod\s+disabled\s+ops\s+Deploy production\s+Maintenance window/);
  assert.doesNotMatch(list.stdout, /internal-toggle/);

  const run = runCovenCode(['plugins', 'run', 'deploy-prod'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(run.status, 2);
  assert.match(run.stderr, /Maintenance window/);
});

test('plugin command availability options must match the documented union', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-availability.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'deploy-prod',
    {
      title: 'Deploy production',
      category: 'ops',
      availability: { type: 'paused' },
    },
    async () => 'deployed',
  );
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin command availability must be enabled, disabled, or hidden: deploy-prod/);
});

test('plugin command disabled availability requires a reason', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-disabled.ts'), `
export default function (covenCode) {
  const command = covenCode.registerCommand(
    'deploy-prod',
    { title: 'Deploy production', category: 'ops' },
    async () => 'deployed',
  );
  command.setAvailability({ type: 'disabled' });
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin command disabled availability reason is required: deploy-prod/);
});

test('plugin command availability rejects fields outside the documented union', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-hidden.ts'), `
export default function (covenCode) {
  const command = covenCode.registerCommand(
    'deploy-prod',
    { title: 'Deploy production', category: 'ops' },
    async () => 'deployed',
  );
  command.setAvailability({ type: 'hidden', reason: 'Not available in this workspace' });
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin command availability fields must match the documented union: deploy-prod/);
});

test('plugin configuration get update and subscribe can drive command availability', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'notifications.ts'), `
export default async function (covenCode) {
  const isEnabled = (config) => config['notifications.enabled'] !== false;
  let mute;
  let unmute;
  const refresh = (enabled) => {
    mute?.setAvailability(enabled ? { type: 'enabled' } : { type: 'hidden' });
    unmute?.setAvailability(enabled ? { type: 'hidden' } : { type: 'enabled' });
  };
  const enabled = isEnabled(await covenCode.configuration.get());
  mute = covenCode.registerCommand('mute-notifications', {
    title: 'Mute notifications',
    category: 'notifications',
    availability: enabled ? { type: 'enabled' } : { type: 'hidden' },
  }, async () => {
    await covenCode.configuration.update({ 'notifications.enabled': false }, 'global');
    return 'muted';
  });
  unmute = covenCode.registerCommand('unmute-notifications', {
    title: 'Unmute notifications',
    category: 'notifications',
    availability: enabled ? { type: 'hidden' } : { type: 'enabled' },
  }, async () => {
    await covenCode.configuration.update({ 'notifications.enabled': true }, 'global');
    return 'unmuted';
  });
  covenCode.configuration.subscribe((config) => {
    refresh(isEnabled(config));
  });
}
`);

  const initial = runCovenCode(['plugins', 'commands'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(initial.status, 0, initial.stderr);
  assert.match(initial.stdout, /mute-notifications\s+enabled\s+notifications\s+Mute notifications/);
  assert.doesNotMatch(initial.stdout, /unmute-notifications/);

  const mute = runCovenCode(['plugins', 'run', 'mute-notifications'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(mute.status, 0, mute.stderr);
  assert.equal(mute.stdout.trim(), 'muted');
  const settings = JSON.parse(await readFile(path.join(xdg, 'coven-code', 'settings.json'), 'utf8'));
  assert.equal(settings['covenCode.notifications.enabled'], false);

  const afterMute = runCovenCode(['plugins', 'commands'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(afterMute.status, 0, afterMute.stderr);
  assert.doesNotMatch(afterMute.stdout, /^mute-notifications/m);
  assert.match(afterMute.stdout, /unmute-notifications\s+enabled\s+notifications\s+Unmute notifications/);
});

test('plugin configuration subscribe accepts observer objects and unsubscribe', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'observer.ts'), `
export default function (covenCode) {
  const observed = [];
  const subscription = covenCode.configuration.subscribe({
    next(config) {
      observed.push(config.showCosts);
    },
  });
  covenCode.registerCommand(
    'observe-configuration',
    {
      title: 'Observe configuration',
      category: 'runtime',
    },
    async () => {
      await covenCode.configuration.update({ showCosts: false }, 'global');
      subscription.unsubscribe();
      await covenCode.configuration.update({ showCosts: true }, 'global');
      return JSON.stringify(observed);
    },
  );
}
`);

  const result = runCovenCode(['plugins', 'run', 'observe-configuration'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [false]);
});

test('plugin configuration implements observable pipe and symbol interop', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'observable.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'inspect-configuration-observable',
    {
      title: 'Inspect configuration observable',
      category: 'runtime',
    },
    async () => {
      const symbol = Symbol.observable ?? Symbol.for('observable');
      const same = covenCode.configuration[symbol]() === covenCode.configuration;
      const observed = [];
      const subscription = covenCode.configuration.pipe((observable) => observable.subscribe((config) => {
        observed.push(config.showCosts);
      }));
      await covenCode.configuration.update({ showCosts: false }, 'global');
      subscription.unsubscribe();
      await covenCode.configuration.update({ showCosts: true }, 'global');
      return JSON.stringify({ same, observed });
    },
  );
}
`);

  const result = runCovenCode(['plugins', 'run', 'inspect-configuration-observable'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { same: true, observed: [false] });
});

test('plugin configuration subscribe requires a function or observer object', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-subscriber.ts'), `
export default function (covenCode) {
  covenCode.configuration.subscribe(null);
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin observable subscriber must be a function or observer object/);
});

test('plugin configuration delete removes global settings keys', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.notifications.enabled': false,
    'covenCode.showCosts': false,
  }));
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'reset-notifications.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'reset-notifications',
    {
      title: 'Reset notifications',
      category: 'notifications',
    },
    async () => {
      await covenCode.configuration.delete('notifications.enabled', 'global');
      return JSON.stringify(await covenCode.configuration.get());
    },
  );
}
`);

  const reset = runCovenCode(['plugins', 'run', 'reset-notifications'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(reset.status, 0, reset.stderr);
  const config = JSON.parse(reset.stdout);
  assert.equal(config['notifications.enabled'], undefined);
  assert.equal(config['covenCode.notifications.enabled'], undefined);
  assert.equal(config['showCosts'], false);
  const settings = JSON.parse(await readFile(path.join(xdg, 'coven-code', 'settings.json'), 'utf8'));
  assert.deepEqual(settings, { 'covenCode.showCosts': false });
});

test('plugin configuration update defaults to workspace settings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'workspace-default.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'disable-costs-for-workspace',
    {
      title: 'Disable costs for workspace',
      category: 'runtime',
    },
    async () => {
      await covenCode.configuration.update({ showCosts: false });
      return 'workspace updated';
    },
  );
}
`);

  const result = runCovenCode(['plugins', 'run', 'disable-costs-for-workspace'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'workspace updated');
  const workspaceSettings = JSON.parse(await readFile(path.join(workspace, '.coven-code', 'settings.json'), 'utf8'));
  assert.equal(workspaceSettings['covenCode.showCosts'], false);
  await assert.rejects(readFile(path.join(xdg, 'coven-code', 'settings.json'), 'utf8'), { code: 'ENOENT' });
});

test('plugin configuration rejects undocumented targets', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-target.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'update-project-target',
    {
      title: 'Update project target',
      category: 'runtime',
    },
    async () => {
      await covenCode.configuration.update({ showCosts: false }, 'project');
    },
  );
}
`);

  const result = runCovenCode(['plugins', 'run', 'update-project-target'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin configuration target must be workspace or global: project/);
});

test('plugin configuration update patch must be an object', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-patch.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'update-array-patch',
    {
      title: 'Update array patch',
      category: 'runtime',
    },
    async () => {
      await covenCode.configuration.update(['not allowed']);
    },
  );
}
`);

  const result = runCovenCode(['plugins', 'run', 'update-array-patch'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin configuration update patch must be an object/);
});

test('plugin configuration delete key must be a string', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-key.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'delete-object-key',
    {
      title: 'Delete object key',
      category: 'runtime',
    },
    async () => {
      await covenCode.configuration.delete({ key: 'showCosts' });
    },
  );
}
`);

  const result = runCovenCode(['plugins', 'run', 'delete-object-key'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin configuration key must be a string/);
});

test('plugin ai.ask returns a yes-no classification with probability and reason', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'ai-classifier.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'classify-production',
    {
      title: 'Classify production work',
      category: 'ai',
    },
    async () => {
      return JSON.stringify(await covenCode.ai.ask('Is this asking to deploy production infrastructure? deploy prod now'));
    },
  );
}
`);

  const result = runCovenCode(['plugins', 'run', 'classify-production'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    result: 'yes',
    probability: 0.9,
    reason: 'local keyword classifier matched: deploy, production',
  });
});

test('plugin ai.ask can return the documented uncertain result', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'ai-uncertain.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'classify-ambiguous',
    {
      title: 'Classify ambiguous work',
      category: 'ai',
    },
    async () => {
      return JSON.stringify(await covenCode.ai.ask('Maybe this is ready, but the prompt is unclear.'));
    },
  );
}
`);

  const result = runCovenCode(['plugins', 'run', 'classify-ambiguous'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    result: 'uncertain',
    probability: 0.5,
    reason: 'local keyword classifier found ambiguity markers',
  });
});

test('plugin ai.ask question must be a string', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'bad-ai.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'ask-object-question',
    {
      title: 'Ask object question',
      category: 'ai',
    },
    async () => {
      return JSON.stringify(await covenCode.ai.ask({ text: 'deploy production?' }));
    },
  );
}
`);

  const result = runCovenCode(['plugins', 'run', 'ask-object-question'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin ai.ask question must be a string/);
});

test('plugin experimental API exposes status items and active thread metadata', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'status.ts'), `
export default function (covenCode) {
  const status = covenCode.experimental.createStatusItem({ text: 'indexing' });
  status.update({ text: 'ready', url: 'command:show-experimental-status' });
  covenCode.registerCommand(
    'show-experimental-status',
    {
      title: 'Show experimental status',
      category: 'runtime',
    },
    async () => {
      status.unsubscribe();
      return JSON.stringify({ threadId: covenCode.experimental.activeThread.current?.id ?? null });
    },
  );
}
`);

  const created = runCovenCode(['--execute', 'seed experimental thread', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(created.status, 0, created.stderr);
  const threadId = JSON.parse(created.stdout.trim().split('\n').at(-1)).session_id;

  const result = runCovenCode(['plugins', 'run', 'show-experimental-status'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { threadId });
});

test('plugin activeThread subscribe requires a function or observer object', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-active-thread-subscriber.ts'), `
export default function (covenCode) {
  covenCode.experimental.activeThread.subscribe(null);
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin observable subscriber must be a function or observer object/);
});

test('plugin experimental status item values require text', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-status-text.ts'), `
export default function (covenCode) {
  covenCode.experimental.createStatusItem({ url: 'command:open-status' });
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin status item text is required/);
});

test('plugin experimental status item urls must be strings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-status-url.ts'), `
export default function (covenCode) {
  const status = covenCode.experimental.createStatusItem({ text: 'indexing' });
  status.update({ text: 'ready', url: new URL('https://coven-code.com') });
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin status item url must be a string/);
});

test('plugin experimental status item values reject undocumented fields', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-status-field.ts'), `
export default function (covenCode) {
  covenCode.experimental.createStatusItem({ text: 'indexing', tooltip: 'Indexing project' });
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin status item fields must be text or url/);
});

test('plugin experimental status item updates reject undocumented fields', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'invalid-status-update-field.ts'), `
export default function (covenCode) {
  const status = covenCode.experimental.createStatusItem({ text: 'indexing' });
  status.update({ text: 'ready', color: 'green' });
}
`);

  const result = runCovenCode(['plugins', 'reload'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin status item fields must be text or url/);
});

test('plugin command context exposes ai.ask and shell execution helpers', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'command-context.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'show-command-context',
    {
      title: 'Show command context',
      category: 'runtime',
    },
    async (ctx) => {
      const answer = await ctx.ai.ask('Is this asking to deploy production? no deployment here');
      const pwd = await ctx.$\`pwd\`;
      return JSON.stringify({ answer, keys: Object.keys(ctx).sort(), pwd: pwd.stdout.trim(), exitCode: pwd.exitCode });
    },
  );
}
`);

  const result = runCovenCode(['plugins', 'run', 'show-command-context'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.answer, {
    result: 'yes',
    probability: 0.9,
    reason: 'local keyword classifier matched: deploy, production',
  });
  assert.deepEqual(payload.keys, ['$', 'ai', 'system', 'thread', 'ui']);
  assert.match(payload.pwd, /\/repo$/);
  assert.equal(payload.exitCode, 0);
});

test('mcp add stores user servers and mcp list reports them', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const addResult = runCovenCode(['mcp', 'add', 'context7', '--', 'npx', '-y', '@upstash/context7-mcp'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(addResult.status, 0, addResult.stderr);
  assert.match(addResult.stdout, /Added MCP server context7/);

  const settings = JSON.parse(await readFile(path.join(xdg, 'coven-code', 'settings.json'), 'utf8'));
  assert.deepEqual(settings['covenCode.mcpServers'].context7, {
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
  });

  const listResult = runCovenCode(['mcp', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /context7\s+user\s+approved\s+npx -y @upstash\/context7-mcp/);
});

test('mcp add stores remote server headers from CLI flags', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const addResult = runCovenCode([
    'mcp',
    'add',
    'linear',
    '--header',
    'Authorization=Bearer test-token',
    '--header',
    'X-Trace-Id=trace-123',
    'https://mcp.linear.app/sse',
  ], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(addResult.status, 0, addResult.stderr);
  assert.match(addResult.stdout, /Added MCP server linear/);

  const settings = JSON.parse(await readFile(path.join(xdg, 'coven-code', 'settings.json'), 'utf8'));
  assert.deepEqual(settings['covenCode.mcpServers'].linear, {
    url: 'https://mcp.linear.app/sse',
    headers: {
      Authorization: 'Bearer test-token',
      'X-Trace-Id': 'trace-123',
    },
  });
});

test('mcp oauth login stores credentials and logout removes them', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));

  const login = runCovenCode([
    'mcp',
    'oauth',
    'login',
    'linear',
    '--server-url',
    'https://mcp.linear.app/sse',
    '--client-id',
    'client-id-123',
    '--client-secret',
    'secret-456',
    '--scopes',
    'read,write',
  ], {
    env: { HOME: home },
  });
  assert.equal(login.status, 0, login.stderr);
  assert.match(login.stdout, /Stored OAuth credentials for linear/);
  assert.doesNotMatch(login.stdout, /secret-456/);

  const credentialPath = path.join(home, '.coven-code', 'oauth', 'linear.json');
  assert.deepEqual(JSON.parse(await readFile(credentialPath, 'utf8')), {
    serverUrl: 'https://mcp.linear.app/sse',
    clientId: 'client-id-123',
    clientSecret: 'secret-456',
    scopes: ['read', 'write'],
  });

  const logout = runCovenCode(['mcp', 'oauth', 'logout', 'linear'], {
    env: { HOME: home },
  });
  assert.equal(logout.status, 0, logout.stderr);
  assert.match(logout.stdout, /Removed OAuth credentials for linear/);
  await assert.rejects(readFile(credentialPath, 'utf8'), /ENOENT/);
});

test('workspace mcp servers require approval before stream-json exposes them', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();

  const addResult = runCovenCode(['mcp', 'add', '--workspace', 'playwright', '--', 'npx', '-y', '@playwright/mcp@latest'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(addResult.status, 0, addResult.stderr);

  const workspaceSettings = JSON.parse(await readFile(path.join(workspace, '.coven-code', 'settings.json'), 'utf8'));
  assert.deepEqual(workspaceSettings['covenCode.mcpServers'].playwright, {
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
  });

  const doctorBefore = runCovenCode(['mcp', 'doctor'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(doctorBefore.status, 0, doctorBefore.stderr);
  assert.match(doctorBefore.stdout, /playwright\s+workspace\s+awaiting approval/);

  const streamBefore = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(streamBefore.status, 0, streamBefore.stderr);
  assert.deepEqual(JSON.parse(streamBefore.stdout.split('\n')[0]).mcp_servers, []);

  const approveResult = runCovenCode(['mcp', 'approve', 'playwright'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(approveResult.status, 0, approveResult.stderr);

  const streamAfter = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(streamAfter.status, 0, streamAfter.stderr);
  const init = JSON.parse(streamAfter.stdout.split('\n')[0]);
  assert.deepEqual(init.mcp_servers, [{ name: 'playwright', status: 'connected' }]);
});

test('workspace settings override user settings for the same mcp server name', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      shared: { command: 'node', args: ['user-server.js'] },
    },
  }));
  await writeFile(path.join(workspace, '.coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      shared: { command: 'node', args: ['workspace-server.js'] },
    },
  }));

  const listResult = runCovenCode(['mcp', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /shared\s+workspace\s+awaiting approval\s+node workspace-server\.js/);
  assert.doesNotMatch(listResult.stdout, /user-server/);
});

test('mcp doctor probes approved local servers for health', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const healthyServer = path.join(home, 'healthy-mcp.mjs');
  const missingServer = path.join(home, 'missing-mcp');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(healthyServer, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (!chunk.includes('tools/list')) return;
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: {
      tools: [
        { name: 'lookup-docs', description: 'Lookup docs' },
        { name: 'search-docs', description: 'Search docs' }
      ]
    }
  }) + '\\n');
});
`);
  await chmod(healthyServer, 0o755);
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      healthy: { command: process.execPath, args: [healthyServer] },
      missing: { command: missingServer },
    },
  }));

  const doctor = runCovenCode(['mcp', 'doctor'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /healthy\s+user\s+approved\s+ok 2 tools\s+/);
  assert.match(doctor.stdout, /missing\s+user\s+approved\s+error ENOENT\s+/);
});

test('managed mcp settings override user and workspace settings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const managedSettings = path.join(home, 'managed-settings.json');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      shared: { command: 'node', args: ['user-server.js'] },
    },
  }));
  await writeFile(path.join(workspace, '.coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      shared: { command: 'node', args: ['workspace-server.js'] },
    },
    'covenCode.mcpPermissions': [
      { matches: { command: 'node', args: 'workspace-server.js' }, action: 'allow' },
    ],
  }));
  await writeFile(managedSettings, JSON.stringify({
    'covenCode.mcpServers': {
      shared: { command: 'node', args: ['managed-server.js'] },
    },
    'covenCode.mcpPermissions': [
      { matches: { command: 'node', args: 'managed-server.js' }, action: 'reject' },
    ],
  }));

  const listResult = runCovenCode(['mcp', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_MANAGED_SETTINGS_FILE: managedSettings },
  });

  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /shared\s+managed\s+rejected\s+node managed-server\.js/);
  assert.doesNotMatch(listResult.stdout, /workspace-server/);
  assert.doesNotMatch(listResult.stdout, /user-server/);
});

test('--mcp-config overrides configured servers with the same name', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const configuredServerPath = path.join(home, 'configured-mcp-server.mjs');
  const inlineServerPath = path.join(home, 'inline-mcp-server.mjs');
  const serverSource = (toolName, description) => `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
	    if (message.method === 'tools/list') {
	      process.stdout.write(JSON.stringify({
	        jsonrpc: '2.0',
	        id: message.id,
        result: {
          tools: [{ name: '${toolName}', description: '${description}' }]
        }
      }) + '\\n');
      process.exit(0);
    }
  }
});
`;
  await writeFile(configuredServerPath, serverSource('configured-tool', 'Configured server tool'));
  await writeFile(inlineServerPath, serverSource('inline-tool', 'Inline server tool'));
  await chmod(configuredServerPath, 0o755);
  await chmod(inlineServerPath, 0o755);
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      shared: {
        command: process.execPath,
        args: [configuredServerPath],
      },
    },
  }));

  const stream = runCovenCode([
    '--mcp-config',
    JSON.stringify({
      mcpServers: {
        shared: {
          command: process.execPath,
          args: [inlineServerPath],
        },
      },
    }),
    '--execute',
    'what is 2+2?',
    '--stream-json',
  ], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(stream.status, 0, stream.stderr);
  const init = JSON.parse(stream.stdout.split('\n')[0]);
  assert.deepEqual(init.mcp_servers, [{ name: 'shared', status: 'connected' }]);
  assert.ok(init.tools.includes('mcp__shared__inline-tool'));
  assert.ok(!init.tools.includes('mcp__shared__configured-tool'));
});

test('--mcp-config accepts a bare JSON server map', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const serverPath = path.join(home, 'bare-map-mcp-server.mjs');
  await writeFile(serverPath, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: [{ name: 'lookup-docs', description: 'Lookup docs' }] },
      }) + '\\n');
      process.exit(0);
    }
  }
});
`);
  await chmod(serverPath, 0o755);

  const stream = runCovenCode([
    '--mcp-config',
    JSON.stringify({
      docs: {
        command: process.execPath,
        args: [serverPath],
      },
    }),
    '--execute',
    'what tools are available?',
    '--stream-json',
  ], {
    env: { HOME: home },
  });

  assert.equal(stream.status, 0, stream.stderr);
  const init = JSON.parse(stream.stdout.split('\n')[0]);
  assert.deepEqual(init.mcp_servers, [{ name: 'docs', status: 'connected' }]);
  assert.ok(init.tools.includes('mcp__docs__lookup-docs'));
});

test('stream json mcp server entries match the documented schema', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const serverPath = path.join(home, 'schema-mcp-server.mjs');
  await writeFile(serverPath, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (!chunk.includes('tools/list')) return;
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { tools: [{ name: 'schema-tool', description: 'Schema test tool' }] },
  }) + '\\n');
});
`);
  await chmod(serverPath, 0o755);

  const result = runCovenCode([
    '--mcp-config',
    JSON.stringify({ docs: { command: process.execPath, args: [serverPath] } }),
    '--execute',
    'what tools are available?',
    '--stream-json',
  ], {
    env: { HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const init = JSON.parse(result.stdout.split('\n')[0]);
  assert.deepEqual(init.mcp_servers, [{ name: 'docs', status: 'connected' }]);
  assert.deepEqual(Object.keys(init.mcp_servers[0]).sort(), ['name', 'status']);
});

test('covenCode.mcpRegistry gates configured MCP servers by registry remotes', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const allowedUrl = 'https://mcp.allowed.example/mcp';
  const blockedUrl = 'https://mcp.blocked.example/mcp';
  const registryPath = path.join(home, 'registry.json');
  await writeFile(registryPath, JSON.stringify({
    servers: [
      {
        server: {
          name: 'example/allowed',
          remotes: [{ type: 'streamable-http', url: allowedUrl }],
        },
      },
    ],
  }));
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpRegistry.url': pathToFileURL(registryPath).href,
    'covenCode.mcpServers': {
      allowed: { url: allowedUrl },
      blocked: { url: blockedUrl },
    },
  }));

  const listResult = runCovenCode(['mcp', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /allowed\s+user\s+approved\s+https:\/\/mcp\.allowed\.example\/mcp/);
  assert.match(listResult.stdout, /blocked\s+user\s+registry-blocked\s+https:\/\/mcp\.blocked\.example\/mcp/);
});

test('covenCode.mcpRegistry blocks all MCP servers when the registry is unreachable', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpRegistry.url': 'http://127.0.0.1:9/v0.1/servers',
    'covenCode.mcpServers': {
      local: { command: 'node', args: ['local-server.js'] },
      remote: { url: 'https://mcp.example.com/mcp' },
    },
  }));

  const listResult = runCovenCode(['mcp', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /local\s+user\s+registry-blocked\s+node local-server\.js/);
  assert.match(listResult.stdout, /remote\s+user\s+registry-blocked\s+https:\/\/mcp\.example\.com\/mcp/);
});

test('covenCode.mcpPermissions rejects matching servers before they become active', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      allowed: { command: 'node', args: ['allowed-server.js'] },
      blockedCommand: { command: 'node', args: ['blocked-server.js'] },
      blockedRemote: { url: 'https://mcp.bad.example/mcp' },
    },
    'covenCode.mcpPermissions': [
      { matches: { command: 'node', args: 'allowed*' }, action: 'allow' },
      { matches: { command: 'node' }, action: 'reject' },
      { matches: { url: '*bad.example*' }, action: 'reject' },
    ],
  }));

  const doctor = runCovenCode(['mcp', 'doctor'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /allowed\s+user\s+approved\s+error exit 1\s+node allowed-server\.js/);
  assert.match(doctor.stdout, /blockedCommand\s+user\s+rejected\s+not probed\s+node blocked-server\.js/);
  assert.match(doctor.stdout, /blockedRemote\s+user\s+rejected\s+not probed\s+https:\/\/mcp\.bad\.example\/mcp/);

  const stream = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(stream.status, 0, stream.stderr);
  assert.deepEqual(JSON.parse(stream.stdout.split('\n')[0]).mcp_servers, [
    { name: 'allowed', status: 'connected' },
  ]);
});

const expectAvailable = spawnSync('expect', ['-v'], { encoding: 'utf8' }).status === 0;

test(
  'piped stdin starts interactive mode when stdout is a TTY',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  () => {
    const script = [
      'log_user 1',
      'set timeout 10',
      `spawn -noecho sh -c {printf 'what is 2+2?\\n' | ${process.execPath} ${covenCodeBin}}`,
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

test(
  'interactive REPL runs a turn, handles /help, and exits cleanly on /exit',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  () => {
    const script = [
      'log_user 1',
      'set timeout 10',
      'set env(HIDDEN_SHELL_OUTPUT) "hidden-live-shell"',
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "what is 2+2?\\r"',
      'expect {',
      '  -re "\\n4\\r?\\n" { }',
      '  timeout { puts "TIMEOUT after math turn"; exit 2 }',
      '}',
      'expect -re "> "',
      'send -- "/help\\r"',
      'expect {',
      '  -re "Slash commands:" { }',
      '  timeout { puts "TIMEOUT after /help"; exit 3 }',
      '}',
      'expect -re "> "',
      'send -- "/exit\\r"',
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

test(
  'interactive REPL command palette help alias shows slash commands',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  () => {
    const script = [
      'log_user 1',
      'set timeout 10',
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "/coven-code: help\\r"',
      'expect {',
      '  -re "Slash commands:" { }',
      '  timeout { puts "TIMEOUT after command-palette help"; exit 2 }',
      '}',
      'expect {',
      '  -re {/mode \\[name\\] +show or set mode: smart, deep, rush, large} { puts "MATCHED_MODE_HELP" }',
      '  timeout { puts "TIMEOUT waiting for mode help line"; exit 7 }',
      '}',
      'expect {',
      '  -re {/editor +compose the next prompt in \\$EDITOR} { }',
      '  timeout { puts "TIMEOUT waiting for editor help line"; exit 3 }',
      '}',
      'expect {',
      '  -re "Keybindings:" { puts "MATCHED_KEYBINDINGS" }',
      '  timeout { puts "TIMEOUT waiting for keybindings help heading"; exit 4 }',
      '}',
      'expect {',
      '  -re {Ctrl\\+G +open the current prompt in \\$EDITOR} { puts "MATCHED_PROMPT_EDITOR_KEYBINDING" }',
      '  timeout { puts "TIMEOUT waiting for prompt editor keybinding"; exit 5 }',
      '}',
      'expect {',
      '  -re {Alt\\+D +cycle reasoning effort for the active mode} { puts "MATCHED_REASONING_KEYBINDING" }',
      '  timeout { puts "TIMEOUT waiting for reasoning keybinding"; exit 6 }',
      '}',
      'expect -re "> "',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /Slash commands:/);
    assert.match(result.stdout, /MATCHED_MODE_HELP/);
    assert.match(result.stdout, /MATCHED_KEYBINDINGS/);
    assert.match(result.stdout, /MATCHED_PROMPT_EDITOR_KEYBINDING/);
    assert.match(result.stdout, /MATCHED_REASONING_KEYBINDING/);
  },
);

test(
  'interactive REPL command palette ide connect reports IDE status',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  () => {
    const script = [
      'log_user 1',
      'set timeout 10',
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "/ide connect\\r"',
      'expect {',
      '  -re "ide: auto" { }',
      '  timeout { puts "TIMEOUT waiting for ide connect status"; exit 2 }',
      '}',
      'expect -re "> "',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /ide: auto/);
    assert.match(result.stdout, /status: unavailable \(local recreation\)/);
  },
);

test(
  'interactive REPL command palette skill-list alias lists skills',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "/skill: list\\r"',
      'expect {',
      '  -re "building-skills +built-in" { }',
      '  timeout { puts "TIMEOUT waiting for skill list"; exit 2 }',
      '}',
      'expect -re "> "',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /building-skills\s+built-in/);
  },
);

test(
  'interactive REPL command palette plugins-reload alias reloads plugins',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "/plugins: reload\\r"',
      'expect {',
      '  -re "Reloaded 0 plugin" { }',
      '  timeout { puts "TIMEOUT waiting for plugins reload"; exit 2 }',
      '}',
      'expect -re "> "',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /Reloaded 0 plugin\(s\)\./);
  },
);

test(
  'interactive REPL command palette runs registered plugin commands by name',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    await mkdir(path.join(cwd, '.coven-code', 'plugins'), { recursive: true });
    await writeFile(path.join(cwd, '.coven-code', 'plugins', 'docs-command.ts'), `
export default function (covenCode) {
  covenCode.registerCommand(
    'open-plugin-docs',
    { title: 'Open plugin docs', category: 'docs' },
    async (ctx) => {
      await ctx.ui.notify('opened plugin docs');
    },
  );
}
`);
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "/open-plugin-docs\\r"',
      'expect {',
      '  -re "opened plugin docs" { }',
      '  timeout { puts "TIMEOUT waiting for plugin command"; exit 2 }',
      '}',
      'expect -re "> "',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /opened plugin docs/);
  },
);

test(
  'interactive REPL keeps thread context across turns',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "the migration codename is quartz-river\\r"',
      'expect -re "> "',
      'send -- "what codename was mentioned earlier?\\r"',
      'expect {',
      '  -re "\\nquartz-river\\r?\\n" { }',
      '  timeout { puts "TIMEOUT waiting for remembered codename"; exit 4 }',
      '}',
      'expect -re "> "',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /quartz-river/);
  },
);

test(
  'interactive REPL /new starts a fresh thread and /continue resumes an existing thread',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "the migration codename is quartz-river\\r"',
      'expect -re "> "',
      'send -- "/threads list\\r"',
      'expect {',
      '  -re "(T-\\[A-Za-z0-9-\\]+) +active" { set first_thread $expect_out(1,string) }',
      '  timeout { puts "TIMEOUT waiting for first thread id"; exit 2 }',
      '}',
      'expect -re "> "',
      'send -- "/new\\r"',
      'expect {',
      '  -re "new thread.*\\r?\\n.*> " { }',
      '  timeout { puts "TIMEOUT waiting for new thread acknowledgement"; exit 3 }',
      '}',
      'send -- "what codename was mentioned earlier?\\r"',
      'expect {',
      '  -re "\\nNo codename was found\\.\\r?\\n" { }',
      '  timeout { puts "TIMEOUT waiting for empty new-thread context"; exit 4 }',
      '}',
      'expect -re "> "',
      'send -- "/continue $first_thread\\r"',
      'expect {',
      '  -re "continued: $first_thread.*\\r?\\n.*> " { }',
      '  timeout { puts "TIMEOUT waiting for continue acknowledgement"; exit 5 }',
      '}',
      'send -- "what codename was mentioned earlier?\\r"',
      'expect {',
      '  -re "\\nquartz-river\\r?\\n" { }',
      '  timeout { puts "TIMEOUT waiting for resumed thread context"; exit 6 }',
      '}',
      'expect -re "> "',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /new thread/);
    assert.match(result.stdout, /continued: T-/);
    assert.match(result.stdout, /quartz-river/);
  },
);

test(
  'interactive REPL command palette archive-and-quit archives the current thread',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "the archive target is current-thread\\r"',
      'expect {',
      '  -re "\\r?\\n> " { }',
      '  timeout { puts "TIMEOUT waiting for initial turn"; exit 2 }',
      '}',
      'send -- "/thread: archive and quit\\r"',
      'expect {',
      '  -re "Archived thread (T-\\[A-Za-z0-9-\\]+)" { set archived_thread $expect_out(1,string) }',
      '  timeout { puts "TIMEOUT waiting for archive acknowledgement"; exit 3 }',
      '}',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /Archived thread T-/);

    const threadDir = path.join(xdg, 'coven-code', 'threads');
    const [threadFile] = await readdir(threadDir);
    const thread = JSON.parse(await readFile(path.join(threadDir, threadFile), 'utf8'));
    assert.equal(thread.archived, true);
  },
);

test(
  'interactive REPL command palette set-visibility updates the current thread',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "the visibility target is current-thread\\r"',
      'expect {',
      '  -re "\\r?\\n> " { }',
      '  timeout { puts "TIMEOUT waiting for initial turn"; exit 2 }',
      '}',
      'send -- "/thread: set visibility public\\r"',
      'expect {',
      '  -re "Set (T-\\[A-Za-z0-9-\\]+) visibility to public" { set visible_thread $expect_out(1,string) }',
      '  timeout { puts "TIMEOUT waiting for visibility acknowledgement"; exit 3 }',
      '}',
      'expect -re "> "',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /Set T-[A-Za-z0-9-]+ visibility to public/);

    const threadDir = path.join(xdg, 'coven-code', 'threads');
    const [threadFile] = await readdir(threadDir);
    const thread = JSON.parse(await readFile(path.join(threadDir, threadFile), 'utf8'));
    assert.equal(thread.visibility, 'public');
  },
);

test(
  'interactive REPL command palette feedback report emits diagnostics for the current thread',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "the feedback target is current-thread\\r"',
      'expect {',
      '  -re "\\r?\\n> " { }',
      '  timeout { puts "TIMEOUT waiting for initial turn"; exit 2 }',
      '}',
      'send -- "/feedback: send report with diagnostics\\r"',
      'expect {',
      '  -re "diagnostic_report_id: R-\\[A-Za-z0-9-\\]+" { }',
      '  timeout { puts "TIMEOUT waiting for diagnostic report"; exit 3 }',
      '}',
      'expect {',
      '  -re "thread_id: (T-\\[A-Za-z0-9-\\]+)" { set report_thread $expect_out(1,string) }',
      '  timeout { puts "TIMEOUT waiting for diagnostic thread id"; exit 4 }',
      '}',
      'expect -re "retention: 7 days"',
      'expect -re "> "',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /diagnostic_report_id: R-/);
    assert.match(result.stdout, /thread_id: T-/);
    assert.match(result.stdout, /retention: 7 days/);
  },
);

test(
  'interactive REPL /mode changes the mode for later turns',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "/mode rush\\r"',
      'expect {',
      '  -re "mode: rush.*\\r?\\n.*> " { }',
      '  timeout { puts "TIMEOUT waiting for mode switch"; exit 5 }',
      '}',
      'send -- "what is 2+2?\\r"',
      'expect -re "\\n4\\r?\\n"',
      'expect -re "> "',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const threadDir = path.join(xdg, 'coven-code', 'threads');
    const [threadFile] = await readdir(threadDir);
    const thread = JSON.parse(await readFile(path.join(threadDir, threadFile), 'utf8'));
    assert.equal(thread.mode, 'rush');
  },
);

test(
  'interactive REPL /reasoning shows and changes reasoning effort',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "/reasoning xhigh\\r"',
      'expect {',
      '  -re "reasoning effort: xhigh.*\\r?\\n.*> " { }',
      '  timeout { puts "TIMEOUT waiting for reasoning switch"; exit 5 }',
      '}',
      'send -- "/reasoning\\r"',
      'expect {',
      '  -re "reasoning effort: xhigh.*\\r?\\n.*> " { }',
      '  timeout { puts "TIMEOUT waiting for reasoning status"; exit 6 }',
      '}',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /reasoning effort: xhigh/);
  },
);

test(
  'interactive REPL editor command opens EDITOR and submits the edited prompt',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const editorScript = path.join(home, 'editor.mjs');
    await writeFile(editorScript, `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], 'what is 2+2?\\n');
`);
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `set env(EDITOR) "${process.execPath} ${editorScript}"`,
      `cd "${cwd}"`,
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "/editor\\r"',
      'expect {',
      '  -re "\\n4\\r?\\n" { }',
      '  timeout { puts "TIMEOUT waiting for editor prompt result"; exit 2 }',
      '}',
      'expect -re "> "',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /\n4\r?\n/);

    const threadDir = path.join(xdg, 'coven-code', 'threads');
    const [threadFile] = await readdir(threadDir);
    const thread = JSON.parse(await readFile(path.join(threadDir, threadFile), 'utf8'));
    assert.equal(thread.messages.at(0).content, 'what is 2+2?');
  },
);

test(
  'interactive REPL edit command replaces the previous user turn',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const editorScript = path.join(home, 'editor.mjs');
    const seedFile = path.join(home, 'edit-seed.txt');
    await writeFile(editorScript, `import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(seedFile)}, readFileSync(process.argv[2], 'utf8'));
writeFileSync(process.argv[2], 'the migration codename is amber-lake\\n');
`);
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `set env(EDITOR) "${process.execPath} ${editorScript}"`,
      `cd "${cwd}"`,
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "the migration codename is quartz-river\\r"',
      'expect -re "> "',
      'send -- "/edit\\r"',
      'expect {',
      '  -re "\\r?\\n> " { }',
      '  timeout { puts "TIMEOUT waiting for edited turn"; exit 2 }',
      '}',
      'send -- "what codename was mentioned earlier?\\r"',
      'expect {',
      '  -re "\\namber-lake\\r?\\n" { }',
      '  timeout { puts "TIMEOUT waiting for edited codename"; exit 3 }',
      '}',
      'expect -re "> "',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /amber-lake/);
    assert.equal(await readFile(seedFile, 'utf8'), 'the migration codename is quartz-river');

    const threadDir = path.join(xdg, 'coven-code', 'threads');
    const [threadFile] = await readdir(threadDir);
    const thread = JSON.parse(await readFile(path.join(threadDir, threadFile), 'utf8'));
    assert.equal(thread.messages[0].content, 'the migration codename is amber-lake');
    assert.equal(thread.messages.filter((message) => message.content === 'the migration codename is quartz-river').length, 0);
  },
);

test(
  'interactive REPL /queue runs a follow-up prompt after the next turn',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "/queue now add 8 to that\\r"',
      'expect {',
      '  -re "queued: now add 8 to that.*\\r?\\n.*> " { }',
      '  timeout { puts "TIMEOUT waiting for queued acknowledgement"; exit 2 }',
      '}',
      'send -- "what is 2+2?\\r"',
      'expect {',
      '  -re "\\n4\\r?\\n" { }',
      '  timeout { puts "TIMEOUT waiting for queued follow-up result"; exit 3 }',
      '}',
      'expect -re "\\n12\\r?\\n"',
      'expect -re "> "',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /\n4\r?\n/);
    assert.match(result.stdout, /\n12\r?\n/);
  },
);

test(
  'interactive REPL passes /<subcommand> through to the top-level dispatcher',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  () => {
    const script = [
      'log_user 1',
      'set timeout 10',
      'set env(HIDDEN_SHELL_OUTPUT) "hidden-live-shell"',
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "/tools list\\r"',
      'expect {',
      '  -re "Task +built-in.*\\r?\\n.*> " { }',
      '  timeout { puts "TIMEOUT after /tools list"; exit 2 }',
      '}',
      'send -- "/nope-not-a-command\\r"',
      'expect {',
      '  -re "Unknown command: nope-not-a-command.*\\r?\\n.*> " { }',
      '  timeout { puts "TIMEOUT after unknown slash command"; exit 3 }',
      '}',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /Bash\s+built-in/);
    assert.match(result.stdout, /Unknown command: nope-not-a-command/);
  },
);

test(
  'interactive REPL slash parser respects double and single quoted args',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  () => {
    const script = [
      'log_user 1',
      'set timeout 10',
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      `send -- "/\\"two words\\" three\\r"`,
      'expect {',
      '  -re "Unknown command: two words" { }',
      '  timeout { puts "TIMEOUT after double-quoted command"; exit 2 }',
      '}',
      'expect -re "> "',
      `send -- "/'single quoted' tail\\r"`,
      'expect {',
      '  -re "Unknown command: single quoted" { }',
      '  timeout { puts "TIMEOUT after single-quoted command"; exit 3 }',
      '}',
      'expect -re "> "',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /Unknown command: two words/);
    assert.match(result.stdout, /Unknown command: single quoted/);
  },
);

test(
  'interactive REPL seeds history from disk and appends new lines for next session',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const historyPath = path.join(home, 'repl_history');
    await writeFile(historyPath, 'what is 2+2?\n');

    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(COVEN_CODE_REPL_HISTORY_FILE) "${historyPath}"`,
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      // Up-arrow recalls the seeded line, Enter submits it.
      'send -- "\\033\\[A\\r"',
      'expect {',
      '  -re "\\n4\\r?\\n" { }',
      '  timeout { puts "TIMEOUT after recalled prompt"; exit 2 }',
      '}',
      'expect -re "> "',
      'send -- "which colorscheme is used? colorscheme nord\\r"',
      'expect {',
      '  -re "nord" { }',
      '  timeout { puts "TIMEOUT after new prompt"; exit 3 }',
      '}',
      'expect -re "> "',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /\n4\r?\n/);

    const after = (await readFile(historyPath, 'utf8')).split(/\r?\n/).filter(Boolean);
    assert.deepEqual(after, [
      'what is 2+2?',
      'what is 2+2?',
      'which colorscheme is used? colorscheme nord',
      '/exit',
    ]);
  },
);

test(
  'interactive REPL joins backslash-continued lines into one multiline prompt',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  () => {
    const script = [
      'log_user 1',
      'set timeout 10',
      `spawn -noecho ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      // First line ends with a single backslash → continuation expected.
      'send -- "colorscheme \\\\\\r"',
      'expect {',
      '  -re "… " { }',
      '  timeout { puts "TIMEOUT waiting for continuation prompt"; exit 2 }',
      '}',
      'send -- "nord\\r"',
      'expect {',
      '  -re "colorscheme used is nord" { }',
      '  timeout { puts "TIMEOUT waiting for joined multiline response"; exit 3 }',
      '}',
      'expect -re "> "',
      'send -- "/exit\\r"',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /colorscheme used is nord/);
  },
);

test('interactive stdin no longer executes manual shell-mode prompts', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const marker = path.join(home, 'shell-mode-marker.txt');
  const command = `$ ${process.execPath} -e "require('node:fs').writeFileSync(process.env.MARKER, 'ran')"\n`;

  const result = runCovenCode([], {
    input: command,
    env: { MARKER: marker },
  });

  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });
});

test('skill management add and remove subcommands are removed', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const source = path.join(home, 'source-skill');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), `---
name: deploy-staging
description: Deploy the service to staging
---
`);

  const addResult = runCovenCode(['skill', 'add', source], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(addResult.status, 2);
  assert.match(addResult.stderr, /Unknown skill command: add/);

  const removeResult = runCovenCode(['skill', 'remove', 'deploy-staging'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(removeResult.status, 2);
  assert.match(removeResult.stderr, /Unknown skill command: remove/);
});

test('skill list and show inspect user-wide skills', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const skillDir = path.join(xdg, 'agents', 'skills', 'deploy-staging');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), `---
name: deploy-staging
description: Deploy the service to staging
---

# Deploy Staging

Run the staging deploy checklist.
`);

  const listResult = runCovenCode(['skill', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /deploy-staging\s+user\s+Deploy the service to staging/);

  const showResult = runCovenCode(['skill', 'show', 'deploy-staging'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(showResult.status, 0, showResult.stderr);
  assert.match(showResult.stdout, /# Deploy Staging/);
});

test('skill discovery follows Coven Code manual precedence for duplicate names', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(xdg, 'agents', 'skills', 'deploy'), { recursive: true });
  await mkdir(path.join(xdg, 'coven-code', 'skills', 'deploy'), { recursive: true });
  await mkdir(path.join(workspace, '.agents', 'skills', 'deploy'), { recursive: true });
  await writeFile(path.join(xdg, 'agents', 'skills', 'deploy', 'SKILL.md'), `---
name: deploy
description: Top user deploy skill
---

Top user skill.
`);
  await writeFile(path.join(xdg, 'coven-code', 'skills', 'deploy', 'SKILL.md'), `---
name: deploy
description: User deploy skill
---

User skill.
`);
  await writeFile(path.join(workspace, '.agents', 'skills', 'deploy', 'SKILL.md'), `---
name: deploy
description: Project deploy skill
---

Project skill.
`);

  const result = runCovenCode(['skill', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deploy\s+user\s+Top user deploy skill/);
  assert.doesNotMatch(result.stdout, /Project deploy skill/);
  assert.doesNotMatch(result.stdout, /User deploy skill/);
});

test('skill discovery includes parent project skills from nested directories', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const nested = path.join(workspace, 'packages', 'app');
  await mkdir(path.join(workspace, '.agents', 'skills', 'release-check'), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(workspace, '.agents', 'skills', 'release-check', 'SKILL.md'), `---
name: release-check
description: Run the repository release checks
---

Release checks.
`);

  const result = runCovenCode(['skill', 'list'], {
    cwd: nested,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release-check\s+project\s+Run the repository release checks/);
});

test('skill discovery includes the built-in building-skills skill', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const listResult = runCovenCode(['skill', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /building-skills\s+built-in\s+Create Coven Code skills for a codebase or workflow/);

  const showResult = runCovenCode(['skill', 'show', 'building-skills'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(showResult.status, 0, showResult.stderr);
  assert.match(showResult.stdout, /# Building Skills/);
});

test('covenCode.skills.path adds colon-separated skill search roots with home expansion', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const firstRoot = path.join(home, 'team-skills');
  const secondRoot = path.join(home, 'personal-skills');
  await mkdir(path.join(firstRoot, 'release'), { recursive: true });
  await mkdir(path.join(secondRoot, 'notes'), { recursive: true });
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(firstRoot, 'release', 'SKILL.md'), `---
name: release
description: Run the team release workflow
---

Release skill.
`);
  await writeFile(path.join(secondRoot, 'notes', 'SKILL.md'), `---
name: notes
description: Prepare personal notes
---

Notes skill.
`);
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.skills.path': `${firstRoot}:~/personal-skills`,
  }));

  const result = runCovenCode(['skill', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release\s+user\s+Run the team release workflow/);
  assert.match(result.stdout, /notes\s+user\s+Prepare personal notes/);
});

test('covenCode.skills.disableLegacySkillRoots hides legacy skill directories only', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.agents', 'skills', 'coven-code-native'), { recursive: true });
  await mkdir(path.join(workspace, '.claude', 'skills', 'project-legacy'), { recursive: true });
  await mkdir(path.join(home, '.claude', 'skills', 'user-legacy'), { recursive: true });
  await writeFile(path.join(workspace, '.agents', 'skills', 'coven-code-native', 'SKILL.md'), `---
name: coven-code-native
description: Coven Code native project skill
---

Coven Code native skill.
`);
  await writeFile(path.join(workspace, '.claude', 'skills', 'project-legacy', 'SKILL.md'), `---
name: project-legacy
description: Project legacy skill
---

Project legacy skill.
`);
  await writeFile(path.join(home, '.claude', 'skills', 'user-legacy', 'SKILL.md'), `---
name: user-legacy
description: User legacy skill
---

User legacy skill.
`);
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.skills.disableLegacySkillRoots': true,
  }));

  const result = runCovenCode(['skill', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /coven-code-native\s+project\s+Coven Code native project skill/);
  assert.doesNotMatch(result.stdout, /project-legacy/);
  assert.doesNotMatch(result.stdout, /user-legacy/);
});

test('tools list discovers tools from approved local MCP servers', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const serverPath = path.join(home, 'mcp-server.mjs');
  await writeFile(serverPath, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'resolve-library-id', description: 'Resolve a package name' },
            { name: 'get-library-docs', description: 'Fetch library documentation' }
          ]
        }
	      }) + '\\n');
	      process.exit(0);
	    }
	    if (message.method === 'tools/call') {
	      process.stdout.write(JSON.stringify({
	        jsonrpc: '2.0',
	        id: message.id,
	        result: {
	          content: [
	            { type: 'text', text: 'called:' + message.params.name }
	          ]
	        }
	      }) + '\\n');
	      process.exit(0);
	    }
	  }
	});
	`);
  await chmod(serverPath, 0o755);

  const addResult = runCovenCode(['mcp', 'add', 'context7', '--', process.execPath, serverPath], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(addResult.status, 0, addResult.stderr);

  const listResult = runCovenCode(['tools', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /mcp__context7__resolve-library-id\s+local-mcp\s+Resolve a package name/);
  assert.match(listResult.stdout, /mcp__context7__get-library-docs\s+local-mcp\s+Fetch library documentation/);
});

test('local MCP servers receive initialize lifecycle before tools list', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const recordPath = path.join(home, 'lifecycle-mcp-records.jsonl');
  const serverPath = path.join(home, 'lifecycle-mcp-server.mjs');
  await writeFile(serverPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let initialized = false;
let ready = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const line of chunk.split(/\\r?\\n/).filter(Boolean)) {
    const message = JSON.parse(line);
    appendFileSync(process.env.RECORD_PATH, JSON.stringify({ method: message.method }) + '\\n');
    if (message.method === 'initialize') {
      initialized = true;
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'lifecycle-fixture', version: '1.0.0' }
        }
      }) + '\\n');
      continue;
    }
    if (message.method === 'notifications/initialized') {
      if (initialized) ready = true;
      continue;
    }
    if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: ready
          ? { tools: [{ name: 'lifecycle-tool', description: 'Lifecycle-aware tool' }] }
          : { tools: [] }
      }) + '\\n');
    }
  }
});
`);
  await chmod(serverPath, 0o755);
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      lifecycle: {
        command: process.execPath,
        args: [serverPath],
        env: { RECORD_PATH: recordPath },
      },
    },
  }));

  const listResult = runCovenCode(['tools', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /mcp__lifecycle__lifecycle-tool\s+local-mcp\s+Lifecycle-aware tool/);
  const seen = (await readFile(recordPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).method);
  assert.deepEqual(seen, ['initialize', 'notifications/initialized', 'tools/list']);
});

test('execute mode can invoke an allowed local MCP tool', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const marker = path.join(workspace, 'mcp-tool-events.jsonl');
  const serverPath = path.join(home, 'mcp-server.mjs');
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'mcp-tool-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'mcp__context7__resolve-library-id') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'mcp__context7__resolve-library-id') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'result',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
      status: event.status,
      output: event.output,
    }) + '\\n');
  });
}
`);
  await writeFile(serverPath, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'resolve-library-id', description: 'Resolve a package name' }
          ]
        }
      }) + '\\n');
      process.exit(0);
    }
    if (message.method === 'tools/call') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [
            { type: 'text', text: 'resolved:' + message.params.arguments.libraryName }
          ]
        }
      }) + '\\n');
      process.exit(0);
    }
  }
});
`);
  await chmod(serverPath, 0o755);
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      context7: {
        command: process.execPath,
        args: [serverPath],
      },
    },
    'covenCode.permissions': [
      { action: 'allow', tool: 'mcp__context7__resolve-library-id' },
    ],
  }));

  const result = runCovenCode(['--execute', 'use mcp__context7__resolve-library-id --libraryName react'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'resolved:react');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const input = { libraryName: 'react' };
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.match(events[0].threadId, /^T-/);
  assert.deepEqual(events[0], {
    type: 'call',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
  });
  assert.deepEqual(events[1], {
    type: 'result',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
    status: 'done',
    output: 'resolved:react',
  });
});

test('execute mode can invoke built-in read_mcp_resource for approved local MCP servers', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const marker = path.join(workspace, 'read-mcp-resource-events.jsonl');
  const serverPath = path.join(home, 'mcp-resource-server.mjs');
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'read-mcp-resource-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'read_mcp_resource') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'read_mcp_resource') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'result',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
      status: event.status,
      output: event.output,
    }) + '\\n');
  });
}
`);
  await writeFile(serverPath, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'resources/read') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          contents: [
            { uri: message.params.uri, mimeType: 'text/plain', text: 'resource:' + message.params.uri }
          ]
        }
      }) + '\\n');
      process.exit(0);
    }
  }
});
`);
  await chmod(serverPath, 0o755);
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      docs: {
        command: process.execPath,
        args: [serverPath],
      },
    },
  }));

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use read_mcp_resource --server docs --uri file://docs/guide.md',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'resource:file://docs/guide.md');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const input = { server: 'docs', uri: 'file://docs/guide.md' };
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.match(events[0].threadId, /^T-/);
  assert.deepEqual(events[0], {
    type: 'call',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
  });
  assert.deepEqual(events[1], {
    type: 'result',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
    status: 'done',
    output: 'resource:file://docs/guide.md',
  });
});

test('remote MCP URL servers list and call tools over HTTP with headers', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const portPath = path.join(home, 'remote-mcp-port');
  const recordPath = path.join(home, 'remote-mcp-records.jsonl');
  const serverPath = path.join(home, 'remote-mcp-server.mjs');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(serverPath, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const server = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const message = JSON.parse(body);
    appendFileSync(process.env.RECORD_PATH, JSON.stringify({
      method: message.method,
      auth: request.headers.authorization,
      body: message
    }) + '\\n');
    response.setHeader('content-type', 'application/json');
    if (message.method === 'tools/list') {
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'lookup-docs', description: 'Lookup remote docs' }
          ]
        }
      }));
      return;
    }
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [
          { type: 'text', text: 'remote:' + message.params.arguments.query }
        ]
      }
    }));
  });
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.env.PORT_PATH, String(server.address().port));
});
`);
  await chmod(serverPath, 0o755);
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT_PATH: portPath, RECORD_PATH: recordPath },
    stdio: 'ignore',
  });
  try {
    let port = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        port = (await readFile(portPath, 'utf8')).trim();
        if (port) break;
      } catch {
        await delay(20);
      }
    }
    assert.match(port, /^\d+$/);
    await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
      'covenCode.mcpServers': {
        docs: {
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: 'Bearer test-token' },
        },
      },
      'covenCode.permissions': [
        { action: 'allow', tool: 'mcp__docs__lookup-docs' },
      ],
    }));

    const list = runCovenCode(['tools', 'list'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /mcp__docs__lookup-docs\s+local-mcp\s+Lookup remote docs/);

    const call = runCovenCode(['--execute', 'use mcp__docs__lookup-docs --query react'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });
    assert.equal(call.status, 0, call.stderr);
    assert.equal(call.stdout.trim(), 'remote:react');
    const seen = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(seen.map((entry) => [entry.method, entry.auth]), [
      ['tools/list', 'Bearer test-token'],
      ['tools/call', 'Bearer test-token'],
    ]);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
});

test('remote MCP URL servers initialize and reuse streamable HTTP session ids', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const portPath = path.join(home, 'session-mcp-port');
  const recordPath = path.join(home, 'session-mcp-records.jsonl');
  const serverPath = path.join(home, 'session-mcp-server.mjs');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(serverPath, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const sessionId = 'session-abc-123';
const server = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const message = JSON.parse(body);
    appendFileSync(process.env.RECORD_PATH, JSON.stringify({
      method: message.method,
      session: request.headers['mcp-session-id']
    }) + '\\n');
    if (message.method === 'initialize') {
      response.setHeader('mcp-session-id', sessionId);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'session-fixture', version: '1.0.0' }
        }
      }));
      return;
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202);
      response.end();
      return;
    }
    if (request.headers['mcp-session-id'] !== sessionId) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'missing session' } }));
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (message.method === 'tools/list') {
      response.setHeader('mcp-session-id', sessionId);
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: [{ name: 'session-docs', description: 'Session docs' }] }
      }));
      return;
    }
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'session:' + message.params.arguments.query }] }
    }));
  });
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.env.PORT_PATH, String(server.address().port));
});
`);
  await chmod(serverPath, 0o755);
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT_PATH: portPath, RECORD_PATH: recordPath },
    stdio: 'ignore',
  });
  try {
    let port = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        port = (await readFile(portPath, 'utf8')).trim();
        if (port) break;
      } catch {
        await delay(20);
      }
    }
    assert.match(port, /^\d+$/);
    await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
      'covenCode.mcpServers': {
        docs: { url: `http://127.0.0.1:${port}/mcp` },
      },
      'covenCode.permissions': [
        { action: 'allow', tool: 'mcp__docs__session-docs' },
      ],
    }));

    const call = runCovenCode(['--execute', 'use mcp__docs__session-docs --query react'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });

    assert.equal(call.status, 0, call.stderr);
    assert.equal(call.stdout.trim(), 'session:react');
    const seen = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(seen.map((entry) => [entry.method, entry.session]), [
      ['tools/call', undefined],
      ['initialize', undefined],
      ['notifications/initialized', 'session-abc-123'],
      ['tools/call', 'session-abc-123'],
    ]);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
});

test('remote MCP URL servers use stored OAuth access tokens', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const portPath = path.join(home, 'oauth-mcp-port');
  const recordPath = path.join(home, 'oauth-mcp-records.jsonl');
  const serverPath = path.join(home, 'oauth-mcp-server.mjs');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(home, '.coven-code', 'oauth'), { recursive: true });
  await writeFile(serverPath, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const server = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const message = JSON.parse(body);
    appendFileSync(process.env.RECORD_PATH, JSON.stringify({
      method: message.method,
      auth: request.headers.authorization
    }) + '\\n');
    if (request.headers.authorization !== 'Bearer oauth-token-123') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'unauthorized' } }));
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (message.method === 'tools/list') {
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: [{ name: 'oauth-docs', description: 'OAuth docs' }] }
      }));
      return;
    }
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'oauth:' + message.params.arguments.query }] }
    }));
  });
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.env.PORT_PATH, String(server.address().port));
});
`);
  await chmod(serverPath, 0o755);
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT_PATH: portPath, RECORD_PATH: recordPath },
    stdio: 'ignore',
  });
  try {
    let port = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        port = (await readFile(portPath, 'utf8')).trim();
        if (port) break;
      } catch {
        await delay(20);
      }
    }
    assert.match(port, /^\d+$/);
    await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
      'covenCode.mcpServers': {
        docs: { url: `http://127.0.0.1:${port}/mcp` },
      },
      'covenCode.permissions': [
        { action: 'allow', tool: 'mcp__docs__oauth-docs' },
      ],
    }));
    await writeFile(path.join(home, '.coven-code', 'oauth', 'docs.json'), JSON.stringify({
      serverUrl: `http://127.0.0.1:${port}/mcp`,
      accessToken: 'oauth-token-123',
    }));

    const list = runCovenCode(['tools', 'list'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /mcp__docs__oauth-docs\s+local-mcp\s+OAuth docs/);

    const call = runCovenCode(['--execute', 'use mcp__docs__oauth-docs --query react'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });
    assert.equal(call.status, 0, call.stderr);
    assert.equal(call.stdout.trim(), 'oauth:react');
    const seen = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(seen.map((entry) => [entry.method, entry.auth]), [
      ['tools/list', 'Bearer oauth-token-123'],
      ['tools/call', 'Bearer oauth-token-123'],
    ]);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
});

test('remote MCP URL servers refresh stale OAuth access tokens', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const portPath = path.join(home, 'refresh-mcp-port');
  const recordPath = path.join(home, 'refresh-mcp-records.jsonl');
  const serverPath = path.join(home, 'refresh-mcp-server.mjs');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(home, '.coven-code', 'oauth'), { recursive: true });
  await writeFile(serverPath, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const server = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    appendFileSync(process.env.RECORD_PATH, JSON.stringify({
      method: request.method,
      url: request.url,
      auth: request.headers.authorization,
      body
    }) + '\\n');
    if (request.method === 'POST' && request.url === '/oauth/token') {
      const params = new URLSearchParams(body);
      if (params.get('grant_type') !== 'refresh_token' || params.get('refresh_token') !== 'refresh-token-1') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        access_token: 'fresh-token-456',
        refresh_token: 'refresh-token-2',
        expires_in: 3600
      }));
      return;
    }
    const message = JSON.parse(body);
    if (request.headers.authorization !== 'Bearer fresh-token-456') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'expired' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    if (message.method === 'tools/list') {
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: [{ name: 'refresh-docs', description: 'Refresh docs' }] }
      }));
      return;
    }
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'refresh:' + message.params.arguments.query }] }
    }));
  });
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.env.PORT_PATH, String(server.address().port));
});
`);
  await chmod(serverPath, 0o755);
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT_PATH: portPath, RECORD_PATH: recordPath },
    stdio: 'ignore',
  });
  try {
    let port = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        port = (await readFile(portPath, 'utf8')).trim();
        if (port) break;
      } catch {
        await delay(20);
      }
    }
    assert.match(port, /^\d+$/);
    await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
      'covenCode.mcpServers': {
        docs: { url: `http://127.0.0.1:${port}/mcp` },
      },
      'covenCode.permissions': [
        { action: 'allow', tool: 'mcp__docs__refresh-docs' },
      ],
    }));
    const credentialPath = path.join(home, '.coven-code', 'oauth', 'docs.json');
    await writeFile(credentialPath, JSON.stringify({
      serverUrl: `http://127.0.0.1:${port}/mcp`,
      tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
      clientId: 'client-id-1',
      clientSecret: 'secret-1',
      accessToken: 'stale-token-123',
      refreshToken: 'refresh-token-1',
    }));

    const list = runCovenCode(['tools', 'list'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /mcp__docs__refresh-docs\s+local-mcp\s+Refresh docs/);
    const updatedCredential = JSON.parse(await readFile(credentialPath, 'utf8'));
    assert.match(String(updatedCredential.expiresAt), /^\d+$/);
    delete updatedCredential.expiresAt;
    assert.deepEqual(updatedCredential, {
      serverUrl: `http://127.0.0.1:${port}/mcp`,
      tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
      clientId: 'client-id-1',
      clientSecret: 'secret-1',
      accessToken: 'fresh-token-456',
      refreshToken: 'refresh-token-2',
    });

    const call = runCovenCode(['--execute', 'use mcp__docs__refresh-docs --query react'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });
    assert.equal(call.status, 0, call.stderr);
    assert.equal(call.stdout.trim(), 'refresh:react');
    const seen = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(seen.map((entry) => [entry.url, entry.auth]), [
      ['/mcp', 'Bearer stale-token-123'],
      ['/oauth/token', undefined],
      ['/mcp', 'Bearer fresh-token-456'],
      ['/mcp', 'Bearer fresh-token-456'],
    ]);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
});

test('remote MCP URL servers fall back to legacy SSE endpoint discovery', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const portPath = path.join(home, 'legacy-sse-mcp-port');
  const recordPath = path.join(home, 'legacy-sse-mcp-records.jsonl');
  const serverPath = path.join(home, 'legacy-sse-mcp-server.mjs');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(serverPath, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const server = createServer((request, response) => {
  appendFileSync(process.env.RECORD_PATH, JSON.stringify({
    method: request.method,
    url: request.url,
    accept: request.headers.accept,
    auth: request.headers.authorization
  }) + '\\n');
  if (request.method === 'GET' && request.url === '/sse') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('event: endpoint\\ndata: /messages\\n\\n');
    return;
  }
  if (request.method === 'POST' && request.url === '/sse') {
    response.writeHead(405);
    response.end('legacy sse only');
    return;
  }
  if (request.method === 'POST' && request.url === '/messages') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const message = JSON.parse(body);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'legacy-search', description: 'Search legacy docs' }
          ]
        }
      }));
    });
    return;
  }
  response.writeHead(404);
  response.end('not found');
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.env.PORT_PATH, String(server.address().port));
});
`);
  await chmod(serverPath, 0o755);
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT_PATH: portPath, RECORD_PATH: recordPath },
    stdio: 'ignore',
  });
  try {
    let port = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        port = (await readFile(portPath, 'utf8')).trim();
        if (port) break;
      } catch {
        await delay(20);
      }
    }
    assert.match(port, /^\d+$/);
    await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
      'covenCode.mcpServers': {
        legacy: {
          url: `http://127.0.0.1:${port}/sse`,
          headers: { Authorization: 'Bearer legacy-token' },
        },
      },
    }));

    const list = runCovenCode(['tools', 'list'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });

    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /mcp__legacy__legacy-search\s+local-mcp\s+Search legacy docs/);
    const seen = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(seen.map((entry) => [entry.method, entry.url, entry.auth]), [
      ['POST', '/sse', 'Bearer legacy-token'],
      ['GET', '/sse', 'Bearer legacy-token'],
      ['POST', '/messages', 'Bearer legacy-token'],
    ]);
    assert.match(seen[1].accept, /text\/event-stream/);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
});

test('remote MCP URL servers honor explicit SSE transport', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const portPath = path.join(home, 'explicit-sse-mcp-port');
  const recordPath = path.join(home, 'explicit-sse-mcp-records.jsonl');
  const serverPath = path.join(home, 'explicit-sse-mcp-server.mjs');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(serverPath, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const server = createServer((request, response) => {
  appendFileSync(process.env.RECORD_PATH, JSON.stringify({
    method: request.method,
    url: request.url,
    accept: request.headers.accept
  }) + '\\n');
  if (request.method === 'GET' && request.url === '/sse') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('event: endpoint\\ndata: /messages\\n\\n');
    return;
  }
  if (request.method === 'POST' && request.url === '/sse') {
    response.writeHead(500);
    response.end('streamable endpoint should not be probed');
    return;
  }
  if (request.method === 'POST' && request.url === '/messages') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const message = JSON.parse(body);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'forced-sse', description: 'Explicit SSE transport' }
          ]
        }
      }));
    });
    return;
  }
  response.writeHead(404);
  response.end('not found');
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.env.PORT_PATH, String(server.address().port));
});
`);
  await chmod(serverPath, 0o755);
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT_PATH: portPath, RECORD_PATH: recordPath },
    stdio: 'ignore',
  });
  try {
    let port = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        port = (await readFile(portPath, 'utf8')).trim();
        if (port) break;
      } catch {
        await delay(20);
      }
    }
    assert.match(port, /^\d+$/);
    await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
      'covenCode.mcpServers': {
        docs: {
          url: `http://127.0.0.1:${port}/sse`,
          transport: 'sse',
        },
      },
    }));

    const list = runCovenCode(['tools', 'list'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });

    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /mcp__docs__forced-sse\s+local-mcp\s+Explicit SSE transport/);
    const seen = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(seen.map((entry) => [entry.method, entry.url]), [
      ['GET', '/sse'],
      ['POST', '/messages'],
    ]);
    assert.match(seen[0].accept, /text\/event-stream/);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
});

test('configured MCP includeTools filters exposed local MCP tools', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const serverPath = path.join(home, 'mcp-server.mjs');
  await writeFile(serverPath, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'resolve-library-id', description: 'Resolve a package name' },
            { name: 'get-library-docs', description: 'Fetch library documentation' },
            { name: 'dangerous-delete', description: 'Delete production data' }
          ]
        }
      }) + '\\n');
      process.exit(0);
    }
  }
});
`);
  await chmod(serverPath, 0o755);
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      context7: {
        command: process.execPath,
        args: [serverPath],
        includeTools: ['resolve-*', 'get-library-docs'],
      },
    },
  }));

  const listResult = runCovenCode(['tools', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /mcp__context7__resolve-library-id\s+local-mcp\s+Resolve a package name/);
  assert.match(listResult.stdout, /mcp__context7__get-library-docs\s+local-mcp\s+Fetch library documentation/);
  assert.doesNotMatch(listResult.stdout, /mcp__context7__dangerous-delete/);

  const stream = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(stream.status, 0, stream.stderr);
  const init = JSON.parse(stream.stdout.split('\n')[0]);
  assert.ok(init.tools.includes('mcp__context7__resolve-library-id'));
  assert.ok(init.tools.includes('mcp__context7__get-library-docs'));
  assert.ok(!init.tools.includes('mcp__context7__dangerous-delete'));

  const directCall = runCovenCode(['--dangerously-allow-all', '--execute', 'use mcp__context7__dangerous-delete'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(directCall.status, 0, directCall.stderr);
  assert.equal(directCall.stdout.trim(), 'Tool not available: mcp__context7__dangerous-delete');
});

test('disabled MCP servers stay inactive and hidden from tool discovery', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const activeServerPath = path.join(home, 'active-mcp-server.mjs');
  const disabledServerPath = path.join(home, 'disabled-mcp-server.mjs');
  const markerPath = path.join(home, 'disabled-server-ran');
  await writeFile(activeServerPath, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (!chunk.includes('tools/list')) return;
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { tools: [{ name: 'active-tool', description: 'Active MCP tool' }] }
  }) + '\\n');
});
`);
  await writeFile(disabledServerPath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.MARKER_PATH, 'spawned');
process.stdin.resume();
`);
  await chmod(activeServerPath, 0o755);
  await chmod(disabledServerPath, 0o755);
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      active: { command: process.execPath, args: [activeServerPath] },
      disabled: { command: process.execPath, args: [disabledServerPath], env: { MARKER_PATH: markerPath }, disabled: true },
    },
  }));

  const list = runCovenCode(['tools', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /mcp__active__active-tool\s+local-mcp\s+Active MCP tool/);
  assert.doesNotMatch(list.stdout, /mcp__disabled__/);

  const stream = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(stream.status, 0, stream.stderr);
  assert.deepEqual(JSON.parse(stream.stdout.split('\n')[0]).mcp_servers, [
    { name: 'active', status: 'connected' },
  ]);
  await assert.rejects(readFile(markerPath, 'utf8'), /ENOENT/);
});

test('configured MCP servers expand environment variables before spawning', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const serverPath = path.join(home, 'mcp-server.mjs');
  await writeFile(serverPath, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: process.env.MCP_TOOL_NAME, description: process.argv[2] }
          ]
        }
      }) + '\\n');
      process.exit(0);
    }
  }
});
`);
  await chmod(serverPath, 0o755);
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      envdocs: {
        command: '${NODE_BIN}',
        args: [serverPath, 'Docs from ${MCP_DOC_SOURCE}'],
        env: {
          MCP_TOOL_NAME: '${MCP_TOOL_NAME}',
        },
      },
    },
  }));

  const listResult = runCovenCode(['tools', 'list'], {
    env: {
      XDG_CONFIG_HOME: xdg,
      HOME: home,
      NODE_BIN: process.execPath,
      MCP_TOOL_NAME: 'env-docs',
      MCP_DOC_SOURCE: 'config env',
    },
  });

  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /mcp__envdocs__env-docs\s+local-mcp\s+Docs from config env/);
});

test('skill-bundled mcp tools stay hidden until the skill is referenced', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const skillDir = path.join(workspace, '.agents', 'skills', 'ui-preview');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), `---
name: ui-preview
description: Preview local UI changes
---

Use browser tools for UI previews.
`);
  await writeFile(path.join(skillDir, 'mcp.json'), JSON.stringify({
    browser: {
      command: 'fake-browser-mcp',
      includeTools: ['navigate_page', 'take_screenshot'],
    },
  }));

  const base = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(base.status, 0, base.stderr);
  assert.deepEqual(JSON.parse(base.stdout.split('\n')[0]).mcp_servers, []);

  const withSkill = runCovenCode(['--execute', 'use the ui-preview skill to inspect the page', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(withSkill.status, 0, withSkill.stderr);
  const init = JSON.parse(withSkill.stdout.split('\n')[0]);
  assert.deepEqual(init.mcp_servers, [{ name: 'browser', status: 'connected' }]);
  assert.ok(init.tools.includes('mcp__browser__navigate_page'));
  assert.ok(init.tools.includes('mcp__browser__take_screenshot'));
});

test('--skills adds a one-run skill root for execute-mode skill MCP activation', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const skillsRoot = path.join(home, 'extra-skills');
  const skillDir = path.join(skillsRoot, 'data-map');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), `---
name: data-map
description: Map project data flows
---

Use data tools for map prompts.
`);
  await writeFile(path.join(skillDir, 'mcp.json'), JSON.stringify({
    mapper: {
      command: 'fake-mapper-mcp',
      includeTools: ['draw_graph'],
    },
  }));

  const base = runCovenCode(['--execute', 'use the data-map skill to draw a graph', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(base.status, 0, base.stderr);
  assert.deepEqual(JSON.parse(base.stdout.split('\n')[0]).mcp_servers, []);

  const withSkill = runCovenCode(['--skills', skillsRoot, '--execute', 'use the data-map skill to draw a graph', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(withSkill.status, 0, withSkill.stderr);
  const init = JSON.parse(withSkill.stdout.split('\n')[0]);
  assert.deepEqual(init.mcp_servers, [{ name: 'mapper', status: 'connected' }]);
  assert.ok(init.tools.includes('mcp__mapper__draw_graph'));
});

test('execute mode persists threads that can be listed and shown', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(workspace, '.coven-code'), { recursive: true });
  await writeFile(path.join(workspace, '.coven-code', 'settings.json'), JSON.stringify({
    'covenCode.defaultVisibility': { default: 'private' },
  }));

  const run = runCovenCode(['--execute', 'remember the frobnicator migration plan', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const list = runCovenCode(['threads', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, new RegExp(`${threadId}\\s+active\\s+private\\s+-\\s+remember the frobnicator migration plan`));

  const show = runCovenCode(['threads', 'show', threadId], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, new RegExp(`https://coven-code\\.local/threads/${threadId}`));
  assert.match(show.stdout, /visibility: private/);
  assert.match(show.stdout, /labels: -/);
  assert.match(show.stdout, /user: remember the frobnicator migration plan/);
});

test('covenCode.defaultVisibility can map visibility by repository origin', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(workspace, '.git'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code'), { recursive: true });
  await writeFile(path.join(workspace, '.git', 'config'), `[remote "origin"]
	url = git@github.com:example/project.git
`);
  await writeFile(path.join(workspace, '.coven-code', 'settings.json'), JSON.stringify({
    'covenCode.defaultVisibility': {
      'github.com/example/project': 'workspace',
      default: 'private',
    },
  }));

  const run = runCovenCode(['--execute', 'map this repo visibility', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const show = runCovenCode(['threads', 'show', threadId], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /visibility: workspace/);
});

test('stream json input persists each user message as a thread turn', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const input = [
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'what is 2+2?' }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'now add 8 to that' }],
      },
    },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';

  const run = runCovenCode(['--execute', '--stream-json', '--stream-json-input'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
    input,
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const show = runCovenCode(['threads', 'show', threadId], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /user: what is 2\+2\?\nassistant: 4\nuser: now add 8 to that\nassistant: 12/);
});

test('threads visibility updates persisted thread sharing level', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const run = runCovenCode(['--execute', 'draft the public release note', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const update = runCovenCode(['threads', 'visibility', threadId, 'public'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, new RegExp(`Set ${threadId} visibility to public`));

  const show = runCovenCode(['threads', 'show', threadId], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /visibility: public/);

  const workspaceShared = runCovenCode(['threads', 'visibility', threadId, 'workspace-shared'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(workspaceShared.status, 0, workspaceShared.stderr);
  assert.match(workspaceShared.stdout, new RegExp(`Set ${threadId} visibility to workspace`));

  const invalid = runCovenCode(['threads', 'visibility', threadId, 'team'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /visibility must be one of: private, public, workspace, workspace-shared, group, group-shared, unlisted/);
});

test('execute mode stores thread labels, visibility override, and archive flag', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(workspace, '.coven-code'), { recursive: true });
  await writeFile(path.join(workspace, '.coven-code', 'settings.json'), JSON.stringify({
    'covenCode.defaultVisibility': { default: 'workspace' },
  }));

  const run = runCovenCode([
    '--execute',
    'summarize release automation',
    '--stream-json',
    '--label',
    'sdk',
    '--label',
    'summary',
    '--visibility',
    'public',
    '--archive',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const active = runCovenCode(['threads', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(active.status, 0, active.stderr);
  assert.doesNotMatch(active.stdout, new RegExp(threadId));

  const archived = runCovenCode(['threads', 'list', '--archived'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(archived.status, 0, archived.stderr);
  assert.match(archived.stdout, new RegExp(`${threadId}\\s+archived\\s+public\\s+sdk,summary\\s+summarize release automation`));

  const show = runCovenCode(['threads', 'show', threadId], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /status: archived/);
  assert.match(show.stdout, /visibility: public/);
  assert.match(show.stdout, /labels: sdk, summary/);

  const search = runCovenCode(['threads', 'search', 'summary'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, new RegExp(threadId));
});

test('usage reports local estimated usage from persisted threads', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const run = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);

  const usage = runCovenCode(['usage'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(usage.status, 0, usage.stderr);
  assert.match(usage.stdout, /remote_balance: unavailable \(local recreation\)/);
  assert.match(usage.stdout, /threads: 1/);
  assert.match(usage.stdout, /turns: 1/);
  assert.match(usage.stdout, /input_tokens_estimate: 3/);
  assert.match(usage.stdout, /output_tokens_estimate: 1/);
});

test('covenCode.showCosts false hides usage cost and token details', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.showCosts': false,
  }));

  const run = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);

  const usage = runCovenCode(['usage'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(usage.status, 0, usage.stderr);
  assert.match(usage.stdout, /threads: 1/);
  assert.match(usage.stdout, /turns: 1/);
  assert.doesNotMatch(usage.stdout, /remote_balance/);
  assert.doesNotMatch(usage.stdout, /tokens_estimate/);
});

test('threads search finds matching prompts and archive hides threads from active list', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const run = runCovenCode(['--execute', 'investigate indexing logic in src/server/index.ts', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const search = runCovenCode(['threads', 'search', 'indexing'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, new RegExp(threadId));

  const archive = runCovenCode(['threads', 'archive', threadId], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(archive.status, 0, archive.stderr);
  assert.match(archive.stdout, /Archived thread/);

  const active = runCovenCode(['threads', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(active.status, 0, active.stderr);
  assert.doesNotMatch(active.stdout, new RegExp(threadId));

  const archived = runCovenCode(['threads', 'list', '--archived'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(archived.status, 0, archived.stderr);
  assert.match(archived.stdout, new RegExp(`${threadId}\\s+archived`));
});

test('threads search finds persisted threads by creation date', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const run = runCovenCode(['--execute', 'investigate rollout schedule', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;
  const thread = JSON.parse(await readFile(path.join(xdg, 'coven-code', 'threads', `${threadId}.json`), 'utf8'));
  const date = thread.createdAt.slice(0, 10);

  const search = runCovenCode(['threads', 'search', date], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, new RegExp(threadId));
});

test('thread references by @id add prior thread context to execute prompts', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const first = runCovenCode(['--execute', 'the migration codename is quartz-river', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout.trim().split('\n').at(-1)).session_id;

  const second = runCovenCode(['--execute', `what codename was mentioned in @${threadId}?`], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /quartz-river/);
});

test('thread search mentions by @@query add the newest matching prior thread context', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const unrelated = runCovenCode(['--execute', 'the migration codename is old-river', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(unrelated.status, 0, unrelated.stderr);

  const matched = runCovenCode(['--execute', 'the search-anchor codename is amber-lake', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(matched.status, 0, matched.stderr);

  const referenced = runCovenCode(['--execute', 'what codename was mentioned in @@search-anchor?'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(referenced.status, 0, referenced.stderr);
  assert.match(referenced.stdout, /amber-lake/);
  assert.doesNotMatch(referenced.stdout, /old-river/);
});

test('threads continue appends execute-mode turns to the latest active thread', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const first = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout.trim().split('\n').at(-1)).session_id;

  const continued = runCovenCode(['threads', 'continue', '--execute', 'now add 8 to that', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(continued.status, 0, continued.stderr);
  const messages = continued.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.type), ['system', 'user', 'assistant', 'result']);
  assert.equal(messages[0].session_id, threadId);
  assert.equal(messages[2].message.content[0].text, '12');
  assert.equal(messages[3].result, '12');
  assert.equal(messages[3].session_id, threadId);

  const show = runCovenCode(['threads', 'show', threadId], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /user: what is 2\+2\?/);
  assert.match(show.stdout, /assistant: 4/);
  assert.match(show.stdout, /user: now add 8 to that/);
  assert.match(show.stdout, /assistant: 12/);
});

test('global --continue resumes latest or explicit threads in execute mode', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const first = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(first.status, 0, first.stderr);
  const firstThreadId = JSON.parse(first.stdout.trim().split('\n').at(-1)).session_id;

  const latest = runCovenCode(['--continue', '--execute', 'now add 8 to that', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(latest.status, 0, latest.stderr);
  const latestMessages = latest.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(latestMessages[0].session_id, firstThreadId);
  assert.equal(latestMessages[3].result, '12');

  const second = runCovenCode(['--execute', 'the migration codename is jade-signal', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(second.status, 0, second.stderr);
  const secondThreadId = JSON.parse(second.stdout.trim().split('\n').at(-1)).session_id;

  const explicit = runCovenCode(['--continue', firstThreadId, '--execute', 'now add 5 to that', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(explicit.status, 0, explicit.stderr);
  const explicitMessages = explicit.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(explicitMessages[0].session_id, firstThreadId);
  assert.equal(explicitMessages[3].result, '17');

  const secondShow = runCovenCode(['threads', 'show', secondThreadId], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(secondShow.status, 0, secondShow.stderr);
  assert.doesNotMatch(secondShow.stdout, /now add 5 to that/);
});

test('threads handoff is removed in the rebuilt CLI', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const run = runCovenCode(['--execute', 'phase one: add parser tests before implementation', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const handoff = runCovenCode(['threads', 'handoff', threadId, '--goal', 'execute phase two'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(handoff.status, 2);
  assert.match(handoff.stderr, /Unknown threads command: handoff/);
});

test('threads map shows locally connected thread references', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const parent = runCovenCode(['--execute', 'parent thread tracks parser cleanup', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(parent.status, 0, parent.stderr);
  const parentThreadId = JSON.parse(parent.stdout.trim().split('\n').at(-1)).session_id;

  const child = runCovenCode(['--execute', `continue the parser cleanup from @${parentThreadId}`, '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(child.status, 0, child.stderr);
  const childThreadId = JSON.parse(child.stdout.trim().split('\n').at(-1)).session_id;

  const map = runCovenCode(['threads', 'map', childThreadId], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(map.status, 0, map.stderr);
  assert.match(map.stdout, new RegExp(`Thread map for ${childThreadId}`));
  assert.match(map.stdout, new RegExp(`${escapeRegExp(childThreadId)}\\s+continue the parser cleanup`));
  assert.match(map.stdout, new RegExp(`mentions -> ${escapeRegExp(parentThreadId)}\\s+parent thread tracks parser cleanup`));
});

test('threads report creates a diagnostic report id for support', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const run = runCovenCode(['--execute', 'diagnose flaky cli startup', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const report = runCovenCode(['threads', 'report', threadId], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /diagnostic_report_id: R-/);
  assert.match(report.stdout, new RegExp(`thread_id: ${threadId}`));
});

test('SDK execute streams CLI messages and exposes user-message and permission helpers', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const sdk = await import(pathToFileURL(path.join(repoRoot, 'src', 'sdk.mjs')).href);

  assert.deepEqual(sdk.createUserMessage('Analyze this code'), {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Analyze this code' }],
    },
  });
  assert.deepEqual(
    sdk.createPermission('Bash', 'allow', { matches: { cmd: 'git *' }, context: 'thread' }),
    { tool: 'Bash', action: 'allow', matches: { cmd: 'git *' }, context: 'thread' },
  );

  const messages = [];
  for await (const message of sdk.execute({
    prompt: 'what is 2+2?',
    options: {
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
      mode: 'smart',
      reasoningEffort: 'max',
      labels: ['sdk'],
    },
  })) {
    messages.push(message);
  }

  assert.deepEqual(messages.map((message) => message.type), ['system', 'user', 'assistant', 'result']);
  assert.equal(messages[0].agent_mode, 'smart');
  assert.equal(messages[0].reasoning_effort, 'max');
  assert.equal(messages.at(-1).result, '4');

  async function* prompts() {
    yield sdk.createUserMessage('what is 2+2?');
    yield sdk.createUserMessage('now add 8 to that');
  }

  const streamed = [];
  for await (const message of sdk.execute({
    prompt: prompts(),
    options: {
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
      thinking: true,
    },
  })) {
    streamed.push(message);
  }

  assert.deepEqual(streamed.map((message) => message.type), [
    'system',
    'user',
    'assistant',
    'user',
    'assistant',
    'result',
  ]);
  assert.equal(streamed[2].message.content[0].type, 'thinking');
  assert.equal(streamed.at(-1).result, '12');

  const denied = [];
  for await (const message of sdk.execute({
    prompt: 'use Bash --command "echo sdk-denied"',
    options: {
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
      permissions: [
        sdk.createPermission('Bash', 'reject', { matches: { cmd: 'echo sdk-denied' } }),
      ],
    },
  })) {
    denied.push(message);
  }
  const denial = denied.at(-1);
  assert.equal(denial.result, 'Permission denied for Bash');
  assert.deepEqual(denial.permission_denials, [
    'Bash: reject (permission)',
  ]);

  const allowed = [];
  for await (const message of sdk.execute({
    prompt: 'use Bash --command "echo sdk-allowed"',
    options: {
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
      permissions: [
        sdk.createPermission('Bash', 'allow', { matches: { cmd: 'echo sdk-allowed' } }),
      ],
    },
  })) {
    allowed.push(message);
  }
  assert.equal(allowed.at(-1).result, 'sdk-allowed');

  const logFile = path.join(home, 'coven-code-sdk-debug.log');
  for await (const message of sdk.execute({
    prompt: 'what is 2+2?',
    options: {
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
      logLevel: 'debug',
      logFile,
    },
  })) {
    if (message.type === 'result') assert.equal(message.result, '4');
  }
  const log = await readFile(logFile, 'utf8');
  assert.match(log, /level=debug/);
  assert.match(log, /cwd=.*coven-code/);
  assert.match(log, /argv=.*--execute.*what is 2\+2\?.*--stream-json/);
});

test('SDK package coven-code-sdk bin installs an SDK-managed coven-code command', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const covenCodeHome = path.join(home, '.coven-code');

  const help = runCovenCodeSdk(['--help'], { env: { HOME: home, COVEN_CODE_HOME: covenCodeHome } });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: coven-code-sdk install \[--force\]/);

  const unknown = runCovenCodeSdk(['frobnicate'], { env: { HOME: home, COVEN_CODE_HOME: covenCodeHome } });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command: frobnicate/);
  assert.match(unknown.stdout, /Usage: coven-code-sdk install \[--force\]/);

  const install = runCovenCodeSdk(['install', '--force'], { env: { HOME: home, COVEN_CODE_HOME: covenCodeHome } });
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, new RegExp(`Coven Code CLI ${escapeRegExp('0.0.0-recreate')} installed at `));

  const installedCovenCode = path.join(covenCodeHome, 'sdk', 'bin', process.platform === 'win32' ? 'coven-code.cmd' : 'coven-code');
  const version = spawnSync(installedCovenCode, ['--version'], {
    env: { ...process.env, HOME: home, COVEN_CODE_HOME: covenCodeHome },
    encoding: 'utf8',
  });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), '0.0.0-recreate');
});

test('SDK package coven-code-sdk install reuses COVEN_CODE_CLI_PATH unless forced', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const covenCodeHome = path.join(home, '.coven-code');
  const existingCovenCode = path.join(home, 'existing-coven-code.mjs');
  const managedCovenCode = path.join(covenCodeHome, 'sdk', 'bin', process.platform === 'win32' ? 'coven-code.cmd' : 'coven-code');
  await writeFile(existingCovenCode, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('0.0.0-recreate');
  process.exit(0);
}
console.log('existing coven-code');
`);
  await chmod(existingCovenCode, 0o755);

  const reused = runCovenCodeSdk(['install'], {
    env: { HOME: home, COVEN_CODE_HOME: covenCodeHome, COVEN_CODE_CLI_PATH: existingCovenCode },
  });
  assert.equal(reused.status, 0, reused.stderr);
  assert.match(reused.stdout, /Coven Code CLI 0\.0\.0-recreate already satisfies minimum 0\.0\.0-recreate \(COVEN_CODE_CLI_PATH\)\./);
  await assert.rejects(readFile(managedCovenCode, 'utf8'), { code: 'ENOENT' });

  const forced = runCovenCodeSdk(['install', '--force'], {
    env: { HOME: home, COVEN_CODE_HOME: covenCodeHome, COVEN_CODE_CLI_PATH: existingCovenCode },
  });
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /Forcing SDK-managed install; skipping existing CLI detection\./);
  assert.match(forced.stdout, /Coven Code CLI 0\.0\.0-recreate installed at /);
  assert.match(await readFile(managedCovenCode, 'utf8'), new RegExp(escapeRegExp(covenCodeBin)));
});

test('SDK package coven-code-sdk install reuses local npm coven-code package before managed install', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const covenCodeHome = path.join(home, '.coven-code');
  const workspace = await mkdtemp(path.join(tmpdir(), 'coven-code-workspace-'));
  const packageDir = path.join(workspace, 'node_modules', '@opencoven', 'coven-code');
  const localCovenCode = path.join(packageDir, 'bin', 'coven-code.mjs');
  const managedCovenCode = path.join(covenCodeHome, 'sdk', 'bin', process.platform === 'win32' ? 'coven-code.cmd' : 'coven-code');
  await mkdir(path.dirname(localCovenCode), { recursive: true });
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({
    name: '@opencoven/coven-code',
    type: 'module',
    bin: { 'coven-code': './bin/coven-code.mjs' },
  }));
  await writeFile(localCovenCode, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('0.0.0-recreate');
  process.exit(0);
}
console.log('local npm coven-code');
`);
  await chmod(localCovenCode, 0o755);

  const reused = runCovenCodeSdk(['install'], { cwd: workspace, env: { HOME: home, COVEN_CODE_HOME: covenCodeHome } });

  assert.equal(reused.status, 0, reused.stderr);
  assert.match(reused.stdout, /Coven Code CLI 0\.0\.0-recreate already satisfies minimum 0\.0\.0-recreate \(LOCAL_NPM\)\./);
  await assert.rejects(readFile(managedCovenCode, 'utf8'), { code: 'ENOENT' });
});

test('SDK package coven-code-sdk install reuses COVEN_CODE_HOME bin before SDK-managed install', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const covenCodeHome = path.join(home, '.coven-code');
  const homeBin = path.join(covenCodeHome, 'bin');
  const homeCovenCode = path.join(homeBin, process.platform === 'win32' ? 'coven-code.cmd' : 'coven-code');
  const managedCovenCode = path.join(covenCodeHome, 'sdk', 'bin', process.platform === 'win32' ? 'coven-code.cmd' : 'coven-code');
  await mkdir(homeBin, { recursive: true });
  await writeFile(homeCovenCode, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('0.0.0-recreate');
  process.exit(0);
}
console.log('coven-code home cli');
`);
  await chmod(homeCovenCode, 0o755);

  const reused = runCovenCodeSdk(['install'], { env: { HOME: home, COVEN_CODE_HOME: covenCodeHome } });

  assert.equal(reused.status, 0, reused.stderr);
  assert.match(reused.stdout, /Coven Code CLI 0\.0\.0-recreate already satisfies minimum 0\.0\.0-recreate \(COVEN_CODE_HOME\)\./);
  await assert.rejects(readFile(managedCovenCode, 'utf8'), { code: 'ENOENT' });
});

test('SDK package coven-code-sdk install reuses coven-code from PATH', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const covenCodeHome = path.join(home, '.coven-code');
  const binDir = path.join(home, 'bin');
  const pathCovenCode = path.join(binDir, process.platform === 'win32' ? 'coven-code.cmd' : 'coven-code');
  const managedCovenCode = path.join(covenCodeHome, 'sdk', 'bin', process.platform === 'win32' ? 'coven-code.cmd' : 'coven-code');
  await mkdir(binDir, { recursive: true });
  await writeFile(pathCovenCode, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('0.0.0-recreate');
  process.exit(0);
}
console.log('path coven-code cli');
`);
  await chmod(pathCovenCode, 0o755);

  const reused = runCovenCodeSdk(['install'], {
    env: {
      HOME: home,
      COVEN_CODE_HOME: covenCodeHome,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    },
  });

  assert.equal(reused.status, 0, reused.stderr);
  assert.match(reused.stdout, /Coven Code CLI 0\.0\.0-recreate already satisfies minimum 0\.0\.0-recreate \(PATH\)\./);
  await assert.rejects(readFile(managedCovenCode, 'utf8'), { code: 'ENOENT' });
});

test('SDK debug logFile resolves relative to cwd', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const sdk = await import(pathToFileURL(path.join(repoRoot, 'src', 'sdk.mjs')).href);
  const relativeLogFile = `./logs/coven-code-debug-${path.basename(workspace)}.log`;

  for await (const message of sdk.execute({
    prompt: 'what is 2+2?',
    options: {
      cwd: workspace,
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
      logLevel: 'debug',
      logFile: relativeLogFile,
    },
  })) {
    if (message.type === 'result') assert.equal(message.result, '4');
  }

  const relativeLogPath = relativeLogFile.replace(/^\.\//, '');
  const log = await readFile(path.join(workspace, relativeLogPath), 'utf8');
  assert.match(log, /level=debug/);
  assert.match(log, new RegExp(`cwd=${escapeRegExp(workspace)}`));
  await assert.rejects(readFile(path.join(repoRoot, relativeLogPath), 'utf8'), { code: 'ENOENT' });
});

test('SDK debug logLevel writes the CLI command to stderr without logFile', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const sdk = await import(pathToFileURL(path.join(repoRoot, 'src', 'sdk.mjs')).href);
  const originalWrite = process.stderr.write;
  let debugOutput = '';
  process.stderr.write = function write(chunk, ...args) {
    debugOutput += String(chunk);
    if (typeof args.at(-1) === 'function') args.at(-1)();
    return true;
  };

  try {
    for await (const message of sdk.execute({
      prompt: 'what is 2+2?',
      options: {
        cwd: repoRoot,
        env: { XDG_CONFIG_HOME: xdg, HOME: home },
        logLevel: 'debug',
      },
    })) {
      if (message.type === 'result') assert.equal(message.result, '4');
    }
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.match(debugOutput, /level=debug/);
  assert.match(debugOutput, /argv=.*--execute.*what is 2\+2\?.*--stream-json/);
});

test('SDK execute honors COVEN_CODE_CLI_PATH override', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const mockCovenCode = path.join(home, 'mock-coven-code.mjs');
  const argvFile = path.join(home, 'mock-argv.json');
  const sdk = await import(pathToFileURL(path.join(repoRoot, 'src', 'sdk.mjs')).href);
  await writeFile(mockCovenCode, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

writeFileSync(process.env.MOCK_COVEN_CODE_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
const session_id = 'T-mock-sdk';
console.log(JSON.stringify({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id, tools: [], mcp_servers: [] }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 1, is_error: false, num_turns: 1, result: 'mocked sdk cli', session_id }));
`);
  await chmod(mockCovenCode, 0o755);
  const previousCovenCodeCliPath = process.env.COVEN_CODE_CLI_PATH;
  process.env.COVEN_CODE_CLI_PATH = mockCovenCode;

  try {
    const messages = [];
    for await (const message of sdk.execute({
      prompt: 'use the COVEN_CODE_CLI_PATH override',
      options: {
        cwd: repoRoot,
        env: { XDG_CONFIG_HOME: xdg, HOME: home, MOCK_COVEN_CODE_ARGV_FILE: argvFile },
      },
    })) {
      messages.push(message);
    }

    assert.equal(messages.at(-1).result, 'mocked sdk cli');
    const argv = JSON.parse(await readFile(argvFile, 'utf8'));
    assert.ok(argv.includes('--execute'));
    assert.ok(argv.includes('use the COVEN_CODE_CLI_PATH override'));
  } finally {
    if (previousCovenCodeCliPath === undefined) delete process.env.COVEN_CODE_CLI_PATH;
    else process.env.COVEN_CODE_CLI_PATH = previousCovenCodeCliPath;
  }
});

test('SDK execute yields an error result when the CLI exits nonzero', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const sdk = await import(pathToFileURL(path.join(repoRoot, 'src', 'sdk.mjs')).href);

  const messages = [];
  for await (const message of sdk.execute({
    prompt: 'what is 2+2?',
    options: {
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
      mode: 'not-a-mode',
    },
  })) {
    messages.push(message);
  }

  assert.deepEqual(messages, [{
    type: 'result',
    subtype: 'error_during_execution',
    duration_ms: messages[0].duration_ms,
    is_error: true,
    num_turns: 0,
    error: 'coven-code: mode must be one of: smart, deep, rush, large\nRun `coven-code --help` for usage.',
    session_id: messages[0].session_id,
  }]);
  assert.match(messages[0].session_id, /^T-/);
  assert.ok(messages[0].duration_ms >= 0);
});

test('SDK execute preserves CLI-emitted terminal error results without duplicating them', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const sdk = await import(pathToFileURL(path.join(repoRoot, 'src', 'sdk.mjs')).href);
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture","type":"module"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'continue-forever.ts'), `
export default function (covenCode) {
  covenCode.on('agent.end', async () => {
    return { action: 'continue', userMessage: 'what is 2+2?' };
  });
}
`);

  const messages = [];
  for await (const message of sdk.execute({
    prompt: 'start loop',
    options: {
      cwd: workspace,
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    },
  })) {
    messages.push(message);
  }

  const terminalResults = messages.filter((message) => message.type === 'result');
  assert.equal(terminalResults.length, 1);
  assert.equal(terminalResults[0].subtype, 'error_max_turns');
  assert.equal(terminalResults[0].is_error, true);
  assert.match(terminalResults[0].error, /maximum agent continuation turns exceeded/i);
});

test('SDK execute defaults new threads to workspace visibility', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const sdk = await import(pathToFileURL(path.join(repoRoot, 'src', 'sdk.mjs')).href);

  const messages = [];
  for await (const message of sdk.execute({
    prompt: 'summarize sdk default visibility',
    options: {
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    },
  })) {
    messages.push(message);
  }

  const show = runCovenCode(['threads', 'show', messages.at(-1).session_id], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /visibility: workspace/);
});

test('SDK accepts documented team visibility as workspace visibility', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const sdk = await import(pathToFileURL(path.join(repoRoot, 'src', 'sdk.mjs')).href);

  const messages = [];
  for await (const message of sdk.execute({
    prompt: 'summarize sdk team visibility',
    options: {
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
      visibility: 'team',
    },
  })) {
    messages.push(message);
  }

  const show = runCovenCode(['threads', 'show', messages.at(-1).session_id], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /visibility: workspace/);

  const threadId = await sdk.threads.new({
    visibility: 'team',
    cwd: repoRoot,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  const markdown = await sdk.threads.markdown({
    threadId,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.match(markdown, /Visibility: workspace/);
});

test('SDK createPermission preserves custom reject messages', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const sdk = await import(pathToFileURL(path.join(repoRoot, 'src', 'sdk.mjs')).href);
  const permission = sdk.createPermission('Bash', 'reject', {
    matches: { cmd: 'echo sdk-blocked' },
    message: 'Use the project-safe helper instead.',
  });

  assert.deepEqual(permission, {
    tool: 'Bash',
    action: 'reject',
    matches: { cmd: 'echo sdk-blocked' },
    message: 'Use the project-safe helper instead.',
  });

  const messages = [];
  for await (const message of sdk.execute({
    prompt: 'use Bash --command "echo sdk-blocked"',
    options: {
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
      permissions: [permission],
    },
  })) {
    messages.push(message);
  }

  assert.equal(messages.at(-1).result, 'Permission denied for Bash: Use the project-safe helper instead.');
});

test('SDK createPermission requires a delegate target', async () => {
  const sdk = await import(pathToFileURL(path.join(repoRoot, 'src', 'sdk.mjs')).href);

  assert.throws(
    () => sdk.createPermission('Bash', 'delegate'),
    /delegate action requires "to" option/,
  );
  assert.deepEqual(
    sdk.createPermission('Bash', 'delegate', { to: 'coven-code-permission-helper', matches: { cmd: 'gh *' } }),
    { tool: 'Bash', action: 'delegate', matches: { cmd: 'gh *' }, to: 'coven-code-permission-helper' },
  );
});

test('SDK execute aborts promptly while waiting on async input', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const sdk = await import(pathToFileURL(path.join(repoRoot, 'src', 'sdk.mjs')).href);
  const controller = new AbortController();

  async function* slowPrompts() {
    yield sdk.createUserMessage('what is 2+2?');
    await delay(500);
    yield sdk.createUserMessage('now add 8 to that');
  }

  const run = (async () => {
    try {
      for await (const _message of sdk.execute({
        prompt: slowPrompts(),
        signal: controller.signal,
        options: {
          cwd: repoRoot,
          env: { XDG_CONFIG_HOME: xdg, HOME: home },
        },
      })) {
        // Drain messages until abort.
      }
      return new Error('expected abort');
    } catch (error) {
      return error;
    }
  })();

  setTimeout(() => controller.abort(), 30);
  const result = await Promise.race([
    run.then((error) => ({ type: 'settled', error })),
    delay(250).then(() => ({ type: 'timeout' })),
  ]);

  assert.equal(result.type, 'settled', 'SDK execute did not settle promptly after aborting a slow async prompt');
  assert.match(result.error.message, /abort/i);
});

test('SDK settingsFile resolves relative to cwd when permissions are merged', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const sdk = await import(pathToFileURL(path.join(repoRoot, 'src', 'sdk.mjs')).href);
  await writeFile(path.join(workspace, 'settings.json'), JSON.stringify({
    'covenCode.tools.disable': ['web_search'],
  }));

  const messages = [];
  for await (const message of sdk.execute({
    prompt: 'what is 2+2?',
    options: {
      cwd: workspace,
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
      settingsFile: './settings.json',
      permissions: [
        sdk.createPermission('Bash', 'allow', { matches: { cmd: 'echo *' } }),
      ],
    },
  })) {
    messages.push(message);
  }

  assert.equal(messages.at(-1).result, '4');
  assert.ok(!messages[0].tools.includes('web_search'));
});

test('SDK enabledTools narrows stream-json tool discovery', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const sdk = await import(pathToFileURL(path.join(repoRoot, 'src', 'sdk.mjs')).href);

  const messages = [];
  for await (const message of sdk.execute({
    prompt: 'what is 2+2?',
    options: {
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
      enabledTools: ['Read', 'find_*'],
    },
  })) {
    messages.push(message);
  }

  assert.deepEqual(messages[0].tools.sort(), ['Read', 'find_thread']);
  assert.equal(messages.at(-1).result, '4');
});

test('SDK systemPrompt influences execute responses', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const sdk = await import(pathToFileURL(path.join(repoRoot, 'src', 'sdk.mjs')).href);

  const messages = [];
  for await (const message of sdk.execute({
    prompt: 'what codename is configured for this run?',
    options: {
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
      systemPrompt: 'For this SDK run, codename: system-orchid.',
    },
  })) {
    messages.push(message);
  }

  assert.equal(messages.at(-1).result, 'system-orchid');
});

test('SDK threads.new creates an empty thread and threads.markdown renders it', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const sdk = await import(pathToFileURL(path.join(repoRoot, 'src', 'sdk.mjs')).href);

  const threadId = await sdk.threads.new({
    visibility: 'private',
    cwd: repoRoot,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.match(threadId, /^T-/);

  let result;
  for await (const message of sdk.execute({
    prompt: 'what is 2+2?',
    options: {
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
      continue: threadId,
    },
  })) {
    if (message.type === 'result') result = message.result;
  }
  assert.equal(result, '4');

  const markdown = await sdk.threads.markdown({
    threadId,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.match(markdown, new RegExp(`# Thread ${threadId}`));
  assert.match(markdown, /Visibility: private/);
  assert.match(markdown, /## User\n\nwhat is 2\+2\?/);
  assert.match(markdown, /## Assistant\n\n4/);
});
