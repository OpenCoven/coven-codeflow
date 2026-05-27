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
