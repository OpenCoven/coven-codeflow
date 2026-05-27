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
  version,
} from './_helpers.mjs';

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
  assert.match(install.stdout, new RegExp(`Coven Code CLI ${escapeRegExp(version)} installed at `));

  const installedCovenCode = path.join(covenCodeHome, 'sdk', 'bin', process.platform === 'win32' ? 'coven-code.cmd' : 'coven-code');
  const versionRun = spawnSync(installedCovenCode, ['--version'], {
    env: { ...process.env, HOME: home, COVEN_CODE_HOME: covenCodeHome },
    encoding: 'utf8',
  });
  assert.equal(versionRun.status, 0, versionRun.stderr);
  assert.equal(versionRun.stdout.trim(), version);
});

test('SDK package coven-code-sdk install reuses COVEN_CODE_CLI_PATH unless forced', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const covenCodeHome = path.join(home, '.coven-code');
  const existingCovenCode = path.join(home, 'existing-coven-code.mjs');
  const managedCovenCode = path.join(covenCodeHome, 'sdk', 'bin', process.platform === 'win32' ? 'coven-code.cmd' : 'coven-code');
  await writeFile(existingCovenCode, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log(${JSON.stringify(version)});
  process.exit(0);
}
console.log('existing coven-code');
`);
  await chmod(existingCovenCode, 0o755);

  const reused = runCovenCodeSdk(['install'], {
    env: { HOME: home, COVEN_CODE_HOME: covenCodeHome, COVEN_CODE_CLI_PATH: existingCovenCode },
  });
  assert.equal(reused.status, 0, reused.stderr);
  assert.match(reused.stdout, new RegExp(`Coven Code CLI ${escapeRegExp(version)} already satisfies minimum ${escapeRegExp(version)} \\(COVEN_CODE_CLI_PATH\\)\\.`));
  await assert.rejects(readFile(managedCovenCode, 'utf8'), { code: 'ENOENT' });

  const forced = runCovenCodeSdk(['install', '--force'], {
    env: { HOME: home, COVEN_CODE_HOME: covenCodeHome, COVEN_CODE_CLI_PATH: existingCovenCode },
  });
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /Forcing SDK-managed install; skipping existing CLI detection\./);
  assert.match(forced.stdout, new RegExp(`Coven Code CLI ${escapeRegExp(version)} installed at `));
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
  console.log(${JSON.stringify(version)});
  process.exit(0);
}
console.log('local npm coven-code');
`);
  await chmod(localCovenCode, 0o755);

  const reused = runCovenCodeSdk(['install'], { cwd: workspace, env: { HOME: home, COVEN_CODE_HOME: covenCodeHome } });

  assert.equal(reused.status, 0, reused.stderr);
  assert.match(reused.stdout, new RegExp(`Coven Code CLI ${escapeRegExp(version)} already satisfies minimum ${escapeRegExp(version)} \\(LOCAL_NPM\\)\\.`));
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
  console.log(${JSON.stringify(version)});
  process.exit(0);
}
console.log('coven-code home cli');
`);
  await chmod(homeCovenCode, 0o755);

  const reused = runCovenCodeSdk(['install'], { env: { HOME: home, COVEN_CODE_HOME: covenCodeHome } });

  assert.equal(reused.status, 0, reused.stderr);
  assert.match(reused.stdout, new RegExp(`Coven Code CLI ${escapeRegExp(version)} already satisfies minimum ${escapeRegExp(version)} \\(COVEN_CODE_HOME\\)\\.`));
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
  console.log(${JSON.stringify(version)});
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
  assert.match(reused.stdout, new RegExp(`Coven Code CLI ${escapeRegExp(version)} already satisfies minimum ${escapeRegExp(version)} \\(PATH\\)\\.`));
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
