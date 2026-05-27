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
