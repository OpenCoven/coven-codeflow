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
