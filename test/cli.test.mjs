import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const ampBin = path.join(repoRoot, 'bin', 'amp.mjs');

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'amp-recreate-'));
  await writeFile(path.join(dir, 'README.md'), '# Test Workspace\n');
  await writeFile(path.join(dir, 'AGENTS.md'), 'Use short answers.\n');
  await writeFile(path.join(dir, 'package.json'), '{"name":"fixture"}\n');
  return dir;
}

function runAmp(args, options = {}) {
  return spawnSync(process.execPath, [ampBin, ...args], {
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

test('prints a top-level help screen with Amp-compatible command names', () => {
  const result = runAmp(['--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: amp/);
  assert.match(result.stdout, /--execute, -x/);
  assert.match(result.stdout, /tools/);
  assert.match(result.stdout, /permissions/);
  assert.match(result.stdout, /login/);
});

test('execute mode answers a prompt and can inspect markdown files in cwd', async () => {
  const cwd = await makeWorkspace();

  const result = runAmp(['-x', 'what files in this folder are markdown files? Print only the filenames.'], { cwd });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'AGENTS.md\nREADME.md');
});

test('execute mode combines stdin with a prompt', async () => {
  const result = runAmp(['--execute', 'which colorscheme is used?'], {
    input: 'set background=dark\ncolorscheme gruvbox\n',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /gruvbox/);
});

test('review reports configured checks with closer project overrides', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const apiDir = path.join(workspace, 'api');
  await mkdir(path.join(xdg, 'amp', 'checks'), { recursive: true });
  await mkdir(path.join(workspace, '.agents', 'checks'), { recursive: true });
  await mkdir(path.join(apiDir, '.agents', 'checks'), { recursive: true });
  await writeFile(path.join(xdg, 'amp', 'checks', 'security.md'), `---
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

  const result = runAmp(['review'], {
    cwd: apiDir,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Review checks:/);
  assert.match(result.stdout, /security\s+high\s+Read\s+api\/\.agents\/checks\/security\.md\s+API security check/);
  assert.match(result.stdout, /performance\s+medium\s+Grep, Read\s+\.agents\/checks\/performance\.md\s+Performance footguns/);
  assert.doesNotMatch(result.stdout, /Root security check/);
  assert.doesNotMatch(result.stdout, /Global security check/);
  assert.match(result.stdout, /No automated review findings in the local deterministic recreation\./);
});

test('execute mode expands @file mentions from relative, absolute, and home paths', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const cwd = await makeWorkspace();
  await mkdir(path.join(cwd, 'docs'), { recursive: true });
  await writeFile(path.join(cwd, 'docs', 'plan.md'), '# Launch Plan\ncodename: ember-maple\n');
  await writeFile(path.join(home, 'personal.md'), '# Personal Notes\ncodename: home-signal\n');

  const relative = runAmp(['--execute', 'what codename is in @docs/plan.md?'], {
    cwd,
    env: { HOME: home },
  });
  assert.equal(relative.status, 0, relative.stderr);
  assert.match(relative.stdout, /ember-maple/);

  const absolute = runAmp(['--execute', `what codename is in @${path.join(cwd, 'docs', 'plan.md')}?`], {
    cwd,
    env: { HOME: home },
  });
  assert.equal(absolute.status, 0, absolute.stderr);
  assert.match(absolute.stdout, /ember-maple/);

  const homeMention = runAmp(['--execute', 'what codename is in @~/personal.md?'], {
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

  const result = runAmp(['--execute', 'list the codenames in @docs/*.md'], { cwd });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'amber-fern\nriver-bell');
});

test('execute mode truncates text @file mentions and ignores binary files', async () => {
  const cwd = await makeWorkspace();
  await mkdir(path.join(cwd, 'docs'), { recursive: true });
  const longLines = Array.from({ length: 501 }, (_, index) => (
    index === 500 ? 'codename: hidden-after-limit' : `line-${String(index + 1).padStart(3, '0')} ${'x'.repeat(2100)}`
  ));
  await writeFile(path.join(cwd, 'docs', 'long.md'), `${longLines.join('\n')}\n`);
  await writeFile(path.join(cwd, 'docs', 'binary.bin'), Buffer.from([0x63, 0x6f, 0x64, 0x65, 0x6e, 0x61, 0x6d, 0x65, 0x3a, 0x20, 0x62, 0x69, 0x6e, 0x61, 0x72, 0x79, 0x2d, 0x73, 0x65, 0x63, 0x72, 0x65, 0x74, 0x00]));

  const longResult = runAmp(['--execute', 'what codename is in @docs/long.md?'], { cwd });
  assert.equal(longResult.status, 0, longResult.stderr);
  assert.match(longResult.stdout, /No codename was found/);

  const binaryResult = runAmp(['--execute', 'what codename is in @docs/binary.bin?'], { cwd });
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

  const result = runAmp(['--execute', 'what image file is mentioned in @images/sample.png?'], { cwd });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'sample.png image/png 12 bytes');
});

test('stream json emits init, user, assistant, and result messages', async () => {
  const cwd = await makeWorkspace();

  const result = runAmp(['--execute', 'what is 2+2?', '--stream-json'], { cwd });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.type), ['system', 'user', 'assistant', 'result']);
  assert.equal(messages[0].subtype, 'init');
  assert.equal(messages[0].cwd, cwd);
  assert.ok(messages[0].session_id.startsWith('T-'));
  assert.equal(messages[2].message.content[0].text, '4');
  assert.equal(messages[3].result, '4');
});

test('stream json flags enforce documented dependencies', async () => {
  const thinking = runAmp(['--execute', 'what is 2+2?', '--stream-json-thinking']);
  assert.equal(thinking.status, 0, thinking.stderr);
  assert.doesNotThrow(() => JSON.parse(thinking.stdout.split('\n')[0]));

  const inputWithoutStream = runAmp(['--execute', '--stream-json-input'], {
    input: '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"what is 2+2?"}]}}\n',
  });
  assert.equal(inputWithoutStream.status, 2);
  assert.match(inputWithoutStream.stderr, /--stream-json-input requires --stream-json/);

  const inputWithoutExecute = runAmp(['--stream-json', '--stream-json-input'], {
    input: '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"what is 2+2?"}]}}\n',
  });
  assert.equal(inputWithoutExecute.status, 2);
  assert.match(inputWithoutExecute.stderr, /--stream-json requires --execute/);
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

  const result = runAmp(['--execute', '--stream-json', '--stream-json-input'], { cwd, input });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
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

  const result = runAmp(['--execute', '--stream-json', '--stream-json-input'], { cwd, input });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(messages.at(-1).result, 'inline image/png 12 bytes');
});

test('amp.tools.disable filters builtin and toolbox tools in lists and stream json', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const toolsDir = path.join(home, 'tools');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
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
  await writeFile(path.join(xdg, 'amp', 'settings.json'), JSON.stringify({
    'amp.tools.disable': ['builtin:Bash', 'tb__secret*'],
  }));

  const list = runAmp(['tools', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home, AMP_TOOLBOX: toolsDir },
  });
  assert.equal(list.status, 0, list.stderr);
  assert.doesNotMatch(list.stdout, /^Bash\s+built-in/m);
  assert.match(list.stdout, /Read\s+built-in/);
  assert.doesNotMatch(list.stdout, /tb__secret_lookup/);
  assert.match(list.stdout, /tb__public_lookup\s+toolbox\s+Visible lookup tool/);

  const stream = runAmp(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home, AMP_TOOLBOX: toolsDir },
  });
  assert.equal(stream.status, 0, stream.stderr);
  const init = JSON.parse(stream.stdout.split('\n')[0]);
  assert.ok(!init.tools.includes('Bash'));
  assert.ok(init.tools.includes('Read'));
  assert.ok(!init.tools.includes('tb__secret_lookup'));
  assert.ok(init.tools.includes('tb__public_lookup'));
});

test('amp.tools.disable honors --settings-file in tool lists and stream json', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const settingsFile = path.join(home, 'custom-settings.json');
  await writeFile(settingsFile, JSON.stringify({
    'amp.tools.disable': ['builtin:Bash'],
  }));

  const list = runAmp(['--settings-file', settingsFile, 'tools', 'list'], {
    env: { HOME: home },
  });
  assert.equal(list.status, 0, list.stderr);
  assert.doesNotMatch(list.stdout, /^Bash\s+built-in/m);
  assert.match(list.stdout, /Read\s+built-in/);

  const stream = runAmp(['--settings-file', settingsFile, '--execute', 'what is 2+2?', '--stream-json'], {
    env: { HOME: home },
  });
  assert.equal(stream.status, 0, stream.stderr);
  const init = JSON.parse(stream.stdout.split('\n')[0]);
  assert.ok(!init.tools.includes('Bash'));
  assert.ok(init.tools.includes('Read'));
});

test('workspace amp.tools.disable overrides user settings in tool lists and stream json', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await mkdir(path.join(workspace, '.amp'), { recursive: true });
  await writeFile(path.join(xdg, 'amp', 'settings.json'), JSON.stringify({
    'amp.tools.disable': ['builtin:Bash'],
  }));
  await writeFile(path.join(workspace, '.amp', 'settings.json'), JSON.stringify({
    'amp.tools.disable': ['builtin:Read'],
  }));

  const list = runAmp(['tools', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^Bash\s+built-in/m);
  assert.doesNotMatch(list.stdout, /^Read\s+built-in/m);

  const stream = runAmp(['--execute', 'what is 2+2?', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(stream.status, 0, stream.stderr);
  const init = JSON.parse(stream.stdout.split('\n')[0]);
  assert.ok(init.tools.includes('Bash'));
  assert.ok(!init.tools.includes('Read'));
});

test('managed settings override user and workspace settings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const managedSettings = path.join(home, 'managed-settings.json');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await mkdir(path.join(workspace, '.amp'), { recursive: true });
  await writeFile(path.join(xdg, 'amp', 'settings.json'), JSON.stringify({
    'amp.tools.disable': ['builtin:Bash'],
    'amp.permissions': [
      { action: 'allow', tool: 'Bash', matches: { cmd: 'npm test*' } },
    ],
  }));
  await writeFile(path.join(workspace, '.amp', 'settings.json'), JSON.stringify({
    'amp.tools.disable': ['builtin:Read'],
    'amp.permissions': [
      { action: 'allow', tool: 'Bash', matches: { cmd: 'npm test*' } },
    ],
  }));
  await writeFile(managedSettings, JSON.stringify({
    'amp.tools.disable': ['builtin:create_file'],
    'amp.permissions': [
      { action: 'reject', tool: 'Bash', matches: { cmd: 'npm test*' } },
    ],
    'amp.admin.compatibilityDate': '2026-05-24',
  }));

  const tools = runAmp(['tools', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, AMP_MANAGED_SETTINGS_FILE: managedSettings },
  });
  assert.equal(tools.status, 0, tools.stderr);
  assert.match(tools.stdout, /^Bash\s+built-in/m);
  assert.match(tools.stdout, /^Read\s+built-in/m);
  assert.doesNotMatch(tools.stdout, /^create_file\s+built-in/m);

  const decision = runAmp(['permissions', 'test', 'Bash', '--cmd', 'npm test -- --runInBand'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, AMP_MANAGED_SETTINGS_FILE: managedSettings },
  });
  assert.equal(decision.status, 0, decision.stderr);
  assert.match(decision.stdout, /action: reject/);
});

test('settings.jsonc accepts comments, URLs, and trailing commas', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await writeFile(path.join(xdg, 'amp', 'settings.jsonc'), `{
  // Built-in tools can be disabled from JSONC settings.
  "amp.tools.disable": [
    "builtin:Bash",
  ],
  /*
   * Remote MCP server URLs should survive comment stripping.
   */
  "amp.mcpServers": {
    "remote": { "url": "https://mcp.example.com/sse" },
  },
}
`);

  const tools = runAmp(['tools', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(tools.status, 0, tools.stderr);
  assert.doesNotMatch(tools.stdout, /^Bash\s+built-in/m);
  assert.match(tools.stdout, /^Read\s+built-in/m);

  const mcp = runAmp(['mcp', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.match(mcp.stdout, /remote\s+user\s+approved\s+https:\/\/mcp\.example\.com\/sse/);
});

test('permissions list --builtin prints default shell policy rules', () => {
  const result = runAmp(['permissions', 'list', '--builtin']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /allow\s+Bash\s+git status/);
  assert.match(result.stdout, /ask\s+Bash\s+rm -rf/);
});

test('permissions add and test evaluate user rules before builtin rules', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');

  const addResult = runAmp(['permissions', 'add', 'reject', 'Bash', '--cmd', '*terraform*apply*'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(addResult.status, 0, addResult.stderr);
  assert.match(addResult.stdout, /Added permission rule/);

  const testResult = runAmp(['permissions', 'test', 'Bash', '--cmd', 'terraform apply -auto-approve'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(testResult.status, 0, testResult.stderr);
  assert.match(testResult.stdout, /tool: Bash/);
  assert.match(testResult.stdout, /action: reject/);

  const builtinResult = runAmp(['permissions', 'test', 'Bash', '--cmd', 'git status --short'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(builtinResult.status, 0, builtinResult.stderr);
  assert.match(builtinResult.stdout, /action: allow/);
});

test('permissions edit replaces user rules from stdin text format', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');

  const editResult = runAmp(['permissions', 'edit'], {
    input: "ask Bash --cmd '*'\nallow Read --path 'README.md'\n",
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(editResult.status, 0, editResult.stderr);

  const listResult = runAmp(['permissions', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /ask\s+Bash\s+\{"cmd":"\*"\}/);
  assert.match(listResult.stdout, /allow\s+Read\s+\{"path":"README.md"\}/);
});

test('workspace amp.permissions overrides user settings for list and test', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await mkdir(path.join(workspace, '.amp'), { recursive: true });
  await writeFile(path.join(xdg, 'amp', 'settings.json'), JSON.stringify({
    'amp.permissions': [
      { action: 'reject', tool: 'Bash', matches: { cmd: 'npm test*' } },
    ],
  }));
  await writeFile(path.join(workspace, '.amp', 'settings.json'), JSON.stringify({
    'amp.permissions': [
      { action: 'allow', tool: 'Bash', matches: { cmd: 'npm test*' } },
    ],
  }));

  const list = runAmp(['permissions', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /allow\s+Bash\s+\{"cmd":"npm test\*"\}/);
  assert.doesNotMatch(list.stdout, /reject\s+Bash\s+\{"cmd":"npm test\*"\}/);

  const decision = runAmp(['permissions', 'test', 'Bash', '--cmd', 'npm test -- --runInBand'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(decision.status, 0, decision.stderr);
  assert.match(decision.stdout, /action: allow/);
});

test('config edit opens the user settings file in EDITOR', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const editorScript = path.join(home, 'editor.mjs');
  const marker = path.join(home, 'opened.txt');
  await writeFile(editorScript, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.AMP_TEST_MARKER, process.argv[2]);
writeFileSync(process.argv[2], JSON.stringify({ 'amp.showCosts': false }, null, 2) + '\\n');
`);

  const result = runAmp(['config', 'edit'], {
    env: {
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      EDITOR: `${process.execPath} ${editorScript}`,
      AMP_TEST_MARKER: marker,
    },
  });

  const settingsPath = path.join(xdg, 'amp', 'settings.json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(marker, 'utf8'), settingsPath);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { 'amp.showCosts': false });
});

test('config edit --workspace opens the workspace settings file in EDITOR', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const workspace = await makeWorkspace();
  const editorScript = path.join(home, 'editor.mjs');
  const marker = path.join(home, 'opened.txt');
  await writeFile(editorScript, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.AMP_TEST_MARKER, process.argv[2]);
writeFileSync(process.argv[2], JSON.stringify({ 'amp.tools.disable': ['builtin:Bash'] }, null, 2) + '\\n');
`);

  const result = runAmp(['config', 'edit', '--workspace'], {
    cwd: workspace,
    env: {
      HOME: home,
      EDITOR: `${process.execPath} ${editorScript}`,
      AMP_TEST_MARKER: marker,
    },
  });

  const settingsPath = path.join(workspace, '.amp', 'settings.json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readFile(marker, 'utf8')).replace(/^\/private\/var\//, '/var/'), settingsPath);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { 'amp.tools.disable': ['builtin:Bash'] });
});

test('tools make creates a toolbox tool and tools list discovers it', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  await mkdir(xdg, { recursive: true });

  const makeResult = runAmp(['tools', 'make', '--bash', 'run_tests'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(makeResult.status, 0, makeResult.stderr);
  assert.match(makeResult.stdout, /Tool created at:/);

  const toolPath = makeResult.stdout.match(/Tool created at: (.+)/)?.[1]?.trim();
  assert.ok(toolPath);
  assert.match(await readFile(toolPath, 'utf8'), /TOOLBOX_ACTION/);

  const listResult = runAmp(['tools', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /tb__run_tests\s+toolbox/);
});

test('AMP_TOOLBOX scans multiple directories left-to-right and tools show renders JSON schemas', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
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

  const env = { AMP_TOOLBOX: [firstDir, secondDir].join(path.delimiter), HOME: home };
  const listResult = runAmp(['tools', 'list'], { env });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /tb__echo_context\s+toolbox\s+First directory tool/);
  assert.doesNotMatch(listResult.stdout, /Second directory tool/);

  const showResult = runAmp(['tools', 'show', 'tb__echo_context'], { env });
  assert.equal(showResult.status, 0, showResult.stderr);
  assert.match(showResult.stdout, /# tb__echo_context \(toolbox: /);
  assert.match(showResult.stdout, /First directory tool/);
  assert.match(showResult.stdout, /- message \(string\): Message to echo/);
});

test('tools use passes JSON arguments and Amp thread environment to toolbox executables', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
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
    ampThreadId: process.env.AMP_THREAD_ID,
    agentThreadId: process.env.AGENT_THREAD_ID,
    input: JSON.parse(input)
  }));
});
`);
  await chmod(toolPath, 0o755);

  const result = runAmp(['tools', 'use', 'tb__context_dump', '--thread', 'T-fixed-thread', '--message', 'hello'], {
    env: { AMP_TOOLBOX: toolsDir, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.exitCode, 0);
  const output = JSON.parse(response.output);
  assert.equal(output.action, 'execute');
  assert.equal(output.agent, 'amp');
  assert.equal(output.ampThreadId, 'T-fixed-thread');
  assert.equal(output.agentThreadId, 'T-fixed-thread');
  assert.deepEqual(output.input, { message: 'hello' });
});

test('execute mode can invoke an allowed toolbox tool', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const toolsDir = path.join(home, 'tools');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
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
    threadId: process.env.AMP_THREAD_ID,
    message: payload.message
  }));
});
`);
  await chmod(toolPath, 0o755);
  await writeFile(path.join(xdg, 'amp', 'settings.json'), JSON.stringify({
    'amp.permissions': [
      { action: 'allow', tool: 'tb__context_dump' },
    ],
  }));

  const result = runAmp(['--execute', 'use tb__context_dump --message hello'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home, AMP_TOOLBOX: toolsDir },
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.action, 'execute');
  assert.equal(output.agent, 'amp');
  assert.match(output.threadId, /^T-/);
  assert.equal(output.message, 'hello');
});

test('stream json emits toolbox tool_use and tool_result events', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const toolsDir = path.join(home, 'tools');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
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
  await writeFile(path.join(xdg, 'amp', 'settings.json'), JSON.stringify({
    'amp.permissions': [
      { action: 'allow', tool: 'tb__context_dump' },
    ],
  }));

  const result = runAmp(['--execute', 'use tb__context_dump --message hello', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home, AMP_TOOLBOX: toolsDir },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.type), ['system', 'user', 'assistant', 'user', 'assistant', 'result']);
  const toolUse = messages[2].message.content[0];
  assert.equal(toolUse.type, 'tool_use');
  assert.equal(toolUse.name, 'tb__context_dump');
  assert.deepEqual(toolUse.input, { message: 'hello' });
  const toolResult = messages[3].message.content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, toolUse.id);
  assert.match(toolResult.content, /"message":"hello"/);
  assert.match(messages[4].message.content[0].text, /"message":"hello"/);
  assert.match(messages[5].result, /"message":"hello"/);
});

test('stream json reports toolbox permission denials in the final result', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const toolsDir = path.join(home, 'tools');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
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

console.log('should not run');
`);
  await chmod(toolPath, 0o755);

  const result = runAmp(['--execute', 'use tb__context_dump --message hello', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home, AMP_TOOLBOX: toolsDir },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const final = messages.at(-1);
  assert.equal(final.type, 'result');
  assert.match(final.result, /Permission denied for tb__context_dump/);
  assert.deepEqual(final.permission_denials, [
    { tool: 'tb__context_dump', action: 'reject', reason: 'permission' },
  ]);
});

test('agents list reports cwd, parent, and user guidance files', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo', 'app');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(xdg, 'amp', 'AGENTS.md'), 'Personal guidance\n');
  await writeFile(path.join(home, 'repo', 'AGENTS.md'), 'Repo guidance\n');
  await writeFile(path.join(workspace, 'CLAUDE.md'), 'Fallback guidance\n');

  const result = runAmp(['agents', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.ok(lines.some((line) => line.endsWith('/.config/amp/AGENTS.md')));
  assert.ok(lines.some((line) => line.endsWith('/repo/AGENTS.md')));
  assert.ok(lines.some((line) => line.endsWith('/repo/app/CLAUDE.md')));
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

  const result = runAmp(['--execute', 'what codename is in the guidance files?'], { cwd: workspace });

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

  const readme = runAmp(['--execute', 'list the codenames from guidance for @README.md'], { cwd: workspace });
  assert.equal(readme.status, 0, readme.stderr);
  assert.equal(readme.stdout.trim(), 'common-lantern');

  const ts = runAmp(['--execute', 'list the codenames from guidance for @src/app.ts'], { cwd: workspace });
  assert.equal(ts.status, 0, ts.stderr);
  assert.equal(ts.stdout.trim(), 'common-lantern\nts-lantern');
});

test('execute mode includes subtree AGENTS.md when reading files below it', async () => {
  const workspace = await makeWorkspace();
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# Fixture\n');
  await writeFile(path.join(workspace, 'src', 'app.ts'), 'export const app = true;\n');
  await writeFile(path.join(workspace, 'src', 'AGENTS.md'), 'codename: subtree-lantern\n');

  const readme = runAmp(['--execute', 'what codename is in guidance for @README.md?'], { cwd: workspace });
  assert.equal(readme.status, 0, readme.stderr);
  assert.match(readme.stdout, /No codename was found/);

  const source = runAmp(['--execute', 'what codename is in guidance for @src/app.ts?'], { cwd: workspace });
  assert.equal(source.status, 0, source.stderr);
  assert.equal(source.stdout.trim(), 'subtree-lantern');
});

test('plugins list reports project and user plugin files', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'amp', 'plugins'), { recursive: true });
  await mkdir(path.join(workspace, '.amp', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.amp', 'plugins', 'project-status.ts'), 'export default function projectStatus() {}\n');
  await writeFile(path.join(xdg, 'amp', 'plugins', 'notify.ts'), 'export default function notify() {}\n');

  const result = runAmp(['plugins', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.ok(lines.some((line) => line.includes('project-status') && line.includes('project') && line.endsWith('/repo/.amp/plugins/project-status.ts')));
  assert.ok(lines.some((line) => line.includes('notify') && line.includes('user') && line.endsWith('/.config/amp/plugins/notify.ts')));
});

test('tools list includes tools registered by project plugins', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await mkdir(path.join(workspace, '.amp', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.amp', 'plugins', 'project-tools.ts'), `
export default function (amp) {
  amp.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'clean';
    },
  });
}
`);

  const result = runAmp(['tools', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /project_status\s+plugin\s+Show the current project status/);
});

test('stream json init includes tools registered by project plugins', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await mkdir(path.join(workspace, '.amp', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.amp', 'plugins', 'project-tools.ts'), `
export default function (amp) {
  amp.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'clean';
    },
  });
}
`);

  const result = runAmp(['--execute', 'what tools are available?', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const system = JSON.parse(result.stdout.trim().split('\n')[0]);
  assert.ok(system.tools.includes('project_status'));
});

test('execute mode can invoke a plugin-registered tool', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await mkdir(path.join(workspace, '.amp', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.amp', 'plugins', 'project-tools.ts'), `
export default function (amp) {
  amp.registerTool({
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

  const result = runAmp(['--dangerously-allow-all', '--execute', 'use project_status --format short'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'clean', format: 'short' });
});

test('plugin tool.call handlers can reject plugin tool execution', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await mkdir(path.join(workspace, '.amp', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.amp', 'plugins', 'guarded-tools.ts'), `
export default function (amp) {
  amp.on('tool.call', async (event) => {
    if (event.tool === 'project_status') {
      return { action: 'reject-and-continue', message: 'blocked by plugin policy' };
    }
    return { action: 'allow' };
  });
  amp.registerTool({
    name: 'project_status',
    description: 'Show the current project status',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'should not run';
    },
  });
}
`);

  const result = runAmp(['--dangerously-allow-all', '--execute', 'use project_status'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'blocked by plugin policy');
});

test('plugin tool.result handlers can replace plugin tool output', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await mkdir(path.join(workspace, '.amp', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.amp', 'plugins', 'redact-tools.ts'), `
export default function (amp) {
  amp.on('tool.result', async (event) => {
    if (event.tool === 'project_secret') {
      return { status: 'success', output: 'redacted result' };
    }
  });
  amp.registerTool({
    name: 'project_secret',
    description: 'Show the current project secret',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return 'raw result';
    },
  });
}
`);

  const result = runAmp(['--dangerously-allow-all', '--execute', 'use project_secret'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'redacted result');
});

test('plugin agent.start handlers run when execute mode starts a turn', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'agent-start.json');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await mkdir(path.join(workspace, '.amp', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.amp', 'plugins', 'agent-start.ts'), `
import { writeFileSync } from 'node:fs';

export default function (amp) {
  amp.on('agent.start', async (event) => {
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
      message: event.message,
      threadId: event.thread.id,
    }));
  });
}
`);

  const result = runAmp(['--execute', 'hello lifecycle'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const event = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(event.message, 'hello lifecycle');
  assert.match(event.threadId, /^T-/);
});

test('plugin agent.end handlers run with the execute-mode result', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'agent-end.json');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await mkdir(path.join(workspace, '.amp', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.amp', 'plugins', 'agent-end.ts'), `
import { writeFileSync } from 'node:fs';

export default function (amp) {
  amp.on('agent.end', async (event) => {
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
      message: event.message,
      result: event.result,
      threadId: event.thread.id,
    }));
  });
}
`);

  const result = runAmp(['--execute', 'what is 2+2?'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const event = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(event.message, 'what is 2+2?');
  assert.equal(event.result, '4');
  assert.match(event.threadId, /^T-/);
});

test('plugins commands lists and runs registered commands', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await mkdir(path.join(workspace, '.amp', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.amp', 'plugins', 'commands.ts'), `
export default function (amp) {
  amp.registerCommand(
    'open-plugin-docs',
    {
      title: 'Open plugin docs',
      category: 'docs',
      description: 'Open the Amp Plugin API manual page.',
    },
    async (ctx) => {
      ctx.ui.notify('opened plugin docs');
    },
  );
}
`);

  const list = runAmp(['plugins', 'commands'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /open-plugin-docs\s+enabled\s+docs\s+Open plugin docs\s+Open the Amp Plugin API manual page\./);

  const run = runAmp(['plugins', 'run', 'open-plugin-docs'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /opened plugin docs/);
});

test('plugins commands honors disabled and hidden command availability', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await mkdir(path.join(workspace, '.amp', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.amp', 'plugins', 'commands.ts'), `
export default function (amp) {
  const disabled = amp.registerCommand(
    'deploy-prod',
    {
      title: 'Deploy production',
      category: 'ops',
      description: 'Deploys the production service.',
    },
    async () => 'deployed',
  );
  disabled.setAvailability({ type: 'disabled', reason: 'Maintenance window' });

  const hidden = amp.registerCommand(
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

  const list = runAmp(['plugins', 'commands'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /deploy-prod\s+disabled\s+ops\s+Deploy production\s+Maintenance window/);
  assert.doesNotMatch(list.stdout, /internal-toggle/);

  const run = runAmp(['plugins', 'run', 'deploy-prod'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(run.status, 2);
  assert.match(run.stderr, /Maintenance window/);
});

test('mcp add stores user servers and mcp list reports them', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');

  const addResult = runAmp(['mcp', 'add', 'context7', '--', 'npx', '-y', '@upstash/context7-mcp'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(addResult.status, 0, addResult.stderr);
  assert.match(addResult.stdout, /Added MCP server context7/);

  const settings = JSON.parse(await readFile(path.join(xdg, 'amp', 'settings.json'), 'utf8'));
  assert.deepEqual(settings['amp.mcpServers'].context7, {
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
  });

  const listResult = runAmp(['mcp', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /context7\s+user\s+approved\s+npx -y @upstash\/context7-mcp/);
});

test('mcp oauth login stores credentials and logout removes them', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));

  const login = runAmp([
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

  const credentialPath = path.join(home, '.amp', 'oauth', 'linear.json');
  assert.deepEqual(JSON.parse(await readFile(credentialPath, 'utf8')), {
    serverUrl: 'https://mcp.linear.app/sse',
    clientId: 'client-id-123',
    clientSecret: 'secret-456',
    scopes: ['read', 'write'],
  });

  const logout = runAmp(['mcp', 'oauth', 'logout', 'linear'], {
    env: { HOME: home },
  });
  assert.equal(logout.status, 0, logout.stderr);
  assert.match(logout.stdout, /Removed OAuth credentials for linear/);
  await assert.rejects(readFile(credentialPath, 'utf8'), /ENOENT/);
});

test('workspace mcp servers require approval before stream-json exposes them', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();

  const addResult = runAmp(['mcp', 'add', '--workspace', 'playwright', '--', 'npx', '-y', '@playwright/mcp@latest'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(addResult.status, 0, addResult.stderr);

  const workspaceSettings = JSON.parse(await readFile(path.join(workspace, '.amp', 'settings.json'), 'utf8'));
  assert.deepEqual(workspaceSettings['amp.mcpServers'].playwright, {
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
  });

  const doctorBefore = runAmp(['mcp', 'doctor'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(doctorBefore.status, 0, doctorBefore.stderr);
  assert.match(doctorBefore.stdout, /playwright\s+workspace\s+awaiting approval/);

  const streamBefore = runAmp(['--execute', 'what is 2+2?', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(streamBefore.status, 0, streamBefore.stderr);
  assert.deepEqual(JSON.parse(streamBefore.stdout.split('\n')[0]).mcp_servers, []);

  const approveResult = runAmp(['mcp', 'approve', 'playwright'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(approveResult.status, 0, approveResult.stderr);

  const streamAfter = runAmp(['--execute', 'what is 2+2?', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(streamAfter.status, 0, streamAfter.stderr);
  const init = JSON.parse(streamAfter.stdout.split('\n')[0]);
  assert.deepEqual(init.mcp_servers, [{ name: 'playwright', status: 'connected', source: 'workspace' }]);
});

test('workspace settings override user settings for the same mcp server name', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await mkdir(path.join(workspace, '.amp'), { recursive: true });
  await writeFile(path.join(xdg, 'amp', 'settings.json'), JSON.stringify({
    'amp.mcpServers': {
      shared: { command: 'node', args: ['user-server.js'] },
    },
  }));
  await writeFile(path.join(workspace, '.amp', 'settings.json'), JSON.stringify({
    'amp.mcpServers': {
      shared: { command: 'node', args: ['workspace-server.js'] },
    },
  }));

  const listResult = runAmp(['mcp', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /shared\s+workspace\s+awaiting approval\s+node workspace-server\.js/);
  assert.doesNotMatch(listResult.stdout, /user-server/);
});

test('managed mcp settings override user and workspace settings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const managedSettings = path.join(home, 'managed-settings.json');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await mkdir(path.join(workspace, '.amp'), { recursive: true });
  await writeFile(path.join(xdg, 'amp', 'settings.json'), JSON.stringify({
    'amp.mcpServers': {
      shared: { command: 'node', args: ['user-server.js'] },
    },
  }));
  await writeFile(path.join(workspace, '.amp', 'settings.json'), JSON.stringify({
    'amp.mcpServers': {
      shared: { command: 'node', args: ['workspace-server.js'] },
    },
    'amp.mcpPermissions': [
      { matches: { command: 'node', args: 'workspace-server.js' }, action: 'allow' },
    ],
  }));
  await writeFile(managedSettings, JSON.stringify({
    'amp.mcpServers': {
      shared: { command: 'node', args: ['managed-server.js'] },
    },
    'amp.mcpPermissions': [
      { matches: { command: 'node', args: 'managed-server.js' }, action: 'reject' },
    ],
  }));

  const listResult = runAmp(['mcp', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, AMP_MANAGED_SETTINGS_FILE: managedSettings },
  });

  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /shared\s+managed\s+rejected\s+node managed-server\.js/);
  assert.doesNotMatch(listResult.stdout, /workspace-server/);
  assert.doesNotMatch(listResult.stdout, /user-server/);
});

test('--mcp-config overrides configured servers with the same name', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
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
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await writeFile(path.join(xdg, 'amp', 'settings.json'), JSON.stringify({
    'amp.mcpServers': {
      shared: {
        command: process.execPath,
        args: [configuredServerPath],
      },
    },
  }));

  const stream = runAmp([
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
  assert.deepEqual(init.mcp_servers, [{ name: 'shared', status: 'connected', source: 'cli' }]);
  assert.ok(init.tools.includes('mcp__shared__inline-tool'));
  assert.ok(!init.tools.includes('mcp__shared__configured-tool'));
});

test('amp.mcpPermissions rejects matching servers before they become active', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await writeFile(path.join(xdg, 'amp', 'settings.json'), JSON.stringify({
    'amp.mcpServers': {
      allowed: { command: 'node', args: ['allowed-server.js'] },
      blockedCommand: { command: 'node', args: ['blocked-server.js'] },
      blockedRemote: { url: 'https://mcp.bad.example/mcp' },
    },
    'amp.mcpPermissions': [
      { matches: { command: 'node', args: 'allowed*' }, action: 'allow' },
      { matches: { command: 'node' }, action: 'reject' },
      { matches: { url: '*bad.example*' }, action: 'reject' },
    ],
  }));

  const doctor = runAmp(['mcp', 'doctor'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /allowed\s+user\s+approved\s+node allowed-server\.js/);
  assert.match(doctor.stdout, /blockedCommand\s+user\s+rejected\s+node blocked-server\.js/);
  assert.match(doctor.stdout, /blockedRemote\s+user\s+rejected\s+https:\/\/mcp\.bad\.example\/mcp/);

  const stream = runAmp(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(stream.status, 0, stream.stderr);
  assert.deepEqual(JSON.parse(stream.stdout.split('\n')[0]).mcp_servers, [
    { name: 'allowed', status: 'connected', source: 'user' },
  ]);
});

const expectAvailable = spawnSync('expect', ['-v'], { encoding: 'utf8' }).status === 0;

test(
  'interactive REPL runs a turn, handles /help, and exits cleanly on /exit',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  () => {
    const script = [
      'log_user 1',
      'set timeout 10',
      `spawn -noecho ${process.execPath} ${ampBin}`,
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
  'interactive REPL keeps thread context across turns',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho ${process.execPath} ${ampBin}`,
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
  'interactive REPL /mode changes the mode for later turns',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho ${process.execPath} ${ampBin}`,
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
    const threadDir = path.join(xdg, 'amp', 'threads');
    const [threadFile] = await readdir(threadDir);
    const thread = JSON.parse(await readFile(path.join(threadDir, threadFile), 'utf8'));
    assert.equal(thread.mode, 'rush');
  },
);

test(
  'interactive REPL passes /<subcommand> through to the top-level dispatcher',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  () => {
    const script = [
      'log_user 1',
      'set timeout 10',
      `spawn -noecho ${process.execPath} ${ampBin}`,
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
      `spawn -noecho ${process.execPath} ${ampBin}`,
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
    const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
    const historyPath = path.join(home, 'repl_history');
    await writeFile(historyPath, 'what is 2+2?\n');

    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(AMP_REPL_HISTORY_FILE) "${historyPath}"`,
      `spawn -noecho ${process.execPath} ${ampBin}`,
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
      `spawn -noecho ${process.execPath} ${ampBin}`,
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

test('interactive stdin shell mode includes $ output but omits $$ incognito output from context', async () => {
  const visible = runAmp([], {
    input: "$ printf 'visible-shell-output'\nwhat did the shell command output?\n",
  });
  assert.equal(visible.status, 0, visible.stderr);
  assert.match(visible.stdout, /visible-shell-output/);

  const incognito = runAmp([], {
    input: "$$ printf 'hidden-shell-output'\nwhat did the shell command output?\n",
  });
  assert.equal(incognito.status, 0, incognito.stderr);
  assert.match(incognito.stdout, /No shell output is available/);
  assert.doesNotMatch(incognito.stdout, /hidden-shell-output/);
});

test('skill add, list, show, and remove manage user-wide skills from a local path', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const source = path.join(home, 'source-skill');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), `---
name: deploy-staging
description: Deploy the service to staging
---

# Deploy Staging

Run the staging deploy checklist.
`);
  await writeFile(path.join(source, 'script.sh'), '#!/usr/bin/env bash\necho deploy\n');

  const addResult = runAmp(['skill', 'add', source], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(addResult.status, 0, addResult.stderr);
  assert.match(addResult.stdout, /Installed skill deploy-staging/);

  const listResult = runAmp(['skill', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /deploy-staging\s+user\s+Deploy the service to staging/);

  const showResult = runAmp(['skill', 'show', 'deploy-staging'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(showResult.status, 0, showResult.stderr);
  assert.match(showResult.stdout, /# Deploy Staging/);

  const removeResult = runAmp(['skill', 'remove', 'deploy-staging'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(removeResult.status, 0, removeResult.stderr);
  assert.match(removeResult.stdout, /Removed skill deploy-staging/);

  const listAfterRemove = runAmp(['skill', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listAfterRemove.status, 0, listAfterRemove.stderr);
  assert.doesNotMatch(listAfterRemove.stdout, /deploy-staging/);
});

test('skill add installs a skill from a git URL', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const repo = path.join(home, 'remote-skill-repo');
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, 'SKILL.md'), `---
name: git-deploy
description: Deploy from a git-backed skill
---

# Git Deploy

Run the git-backed deploy checklist.
`);
  await writeFile(path.join(repo, 'script.sh'), '#!/usr/bin/env bash\necho git deploy\n');
  const init = runGit(['init'], { cwd: repo });
  assert.equal(init.status, 0, init.stderr);
  const add = runGit(['add', 'SKILL.md', 'script.sh'], { cwd: repo });
  assert.equal(add.status, 0, add.stderr);
  const commit = runGit(['-c', 'user.name=Amp Test', '-c', 'user.email=amp-test@example.com', 'commit', '-m', 'add skill'], { cwd: repo });
  assert.equal(commit.status, 0, commit.stderr);

  const addResult = runAmp(['skill', 'add', `file://${repo}`], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(addResult.status, 0, addResult.stderr);
  assert.match(addResult.stdout, /Installed skill git-deploy/);

  const showResult = runAmp(['skill', 'show', 'git-deploy'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(showResult.status, 0, showResult.stderr);
  assert.match(showResult.stdout, /# Git Deploy/);
});

test('project skills take precedence over user skills with the same name', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(xdg, 'amp', 'skills', 'deploy'), { recursive: true });
  await mkdir(path.join(workspace, '.agents', 'skills', 'deploy'), { recursive: true });
  await writeFile(path.join(xdg, 'amp', 'skills', 'deploy', 'SKILL.md'), `---
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

  const result = runAmp(['skill', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deploy\s+project\s+Project deploy skill/);
  assert.doesNotMatch(result.stdout, /User deploy skill/);
});

test('amp.skills.path adds colon-separated skill search roots with home expansion', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const firstRoot = path.join(home, 'team-skills');
  const secondRoot = path.join(home, 'personal-skills');
  await mkdir(path.join(firstRoot, 'release'), { recursive: true });
  await mkdir(path.join(secondRoot, 'notes'), { recursive: true });
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
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
  await writeFile(path.join(xdg, 'amp', 'settings.json'), JSON.stringify({
    'amp.skills.path': `${firstRoot}:~/personal-skills`,
  }));

  const result = runAmp(['skill', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release\s+user\s+Run the team release workflow/);
  assert.match(result.stdout, /notes\s+user\s+Prepare personal notes/);
});

test('amp.skills.disableClaudeCodeSkills hides Claude Code skill directories only', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await mkdir(path.join(workspace, '.agents', 'skills', 'amp-native'), { recursive: true });
  await mkdir(path.join(workspace, '.claude', 'skills', 'project-claude'), { recursive: true });
  await mkdir(path.join(home, '.claude', 'skills', 'user-claude'), { recursive: true });
  await writeFile(path.join(workspace, '.agents', 'skills', 'amp-native', 'SKILL.md'), `---
name: amp-native
description: Amp native project skill
---

Amp native skill.
`);
  await writeFile(path.join(workspace, '.claude', 'skills', 'project-claude', 'SKILL.md'), `---
name: project-claude
description: Project Claude Code skill
---

Project Claude skill.
`);
  await writeFile(path.join(home, '.claude', 'skills', 'user-claude', 'SKILL.md'), `---
name: user-claude
description: User Claude Code skill
---

User Claude skill.
`);
  await writeFile(path.join(xdg, 'amp', 'settings.json'), JSON.stringify({
    'amp.skills.disableClaudeCodeSkills': true,
  }));

  const result = runAmp(['skill', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /amp-native\s+project\s+Amp native project skill/);
  assert.doesNotMatch(result.stdout, /project-claude/);
  assert.doesNotMatch(result.stdout, /user-claude/);
});

test('tools list discovers tools from approved local MCP servers', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
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
  }
});
`);
  await chmod(serverPath, 0o755);

  const addResult = runAmp(['mcp', 'add', 'context7', '--', process.execPath, serverPath], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(addResult.status, 0, addResult.stderr);

  const listResult = runAmp(['tools', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /mcp__context7__resolve-library-id\s+local-mcp\s+Resolve a package name/);
  assert.match(listResult.stdout, /mcp__context7__get-library-docs\s+local-mcp\s+Fetch library documentation/);
});

test('execute mode can invoke an allowed local MCP tool', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
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
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await writeFile(path.join(xdg, 'amp', 'settings.json'), JSON.stringify({
    'amp.mcpServers': {
      context7: {
        command: process.execPath,
        args: [serverPath],
      },
    },
    'amp.permissions': [
      { action: 'allow', tool: 'mcp__context7__resolve-library-id' },
    ],
  }));

  const result = runAmp(['--execute', 'use mcp__context7__resolve-library-id --libraryName react'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'resolved:react');
});

test('configured MCP includeTools filters exposed local MCP tools', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
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
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await writeFile(path.join(xdg, 'amp', 'settings.json'), JSON.stringify({
    'amp.mcpServers': {
      context7: {
        command: process.execPath,
        args: [serverPath],
        includeTools: ['resolve-*', 'get-library-docs'],
      },
    },
  }));

  const listResult = runAmp(['tools', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /mcp__context7__resolve-library-id\s+local-mcp\s+Resolve a package name/);
  assert.match(listResult.stdout, /mcp__context7__get-library-docs\s+local-mcp\s+Fetch library documentation/);
  assert.doesNotMatch(listResult.stdout, /mcp__context7__dangerous-delete/);

  const stream = runAmp(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(stream.status, 0, stream.stderr);
  const init = JSON.parse(stream.stdout.split('\n')[0]);
  assert.ok(init.tools.includes('mcp__context7__resolve-library-id'));
  assert.ok(init.tools.includes('mcp__context7__get-library-docs'));
  assert.ok(!init.tools.includes('mcp__context7__dangerous-delete'));
});

test('configured MCP servers expand environment variables before spawning', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
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
  await mkdir(path.join(xdg, 'amp'), { recursive: true });
  await writeFile(path.join(xdg, 'amp', 'settings.json'), JSON.stringify({
    'amp.mcpServers': {
      envdocs: {
        command: '${NODE_BIN}',
        args: [serverPath, 'Docs from ${MCP_DOC_SOURCE}'],
        env: {
          MCP_TOOL_NAME: '${MCP_TOOL_NAME}',
        },
      },
    },
  }));

  const listResult = runAmp(['tools', 'list'], {
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
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
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

  const base = runAmp(['--execute', 'what is 2+2?', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(base.status, 0, base.stderr);
  assert.deepEqual(JSON.parse(base.stdout.split('\n')[0]).mcp_servers, []);

  const withSkill = runAmp(['--execute', 'use the ui-preview skill to inspect the page', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(withSkill.status, 0, withSkill.stderr);
  const init = JSON.parse(withSkill.stdout.split('\n')[0]);
  assert.deepEqual(init.mcp_servers, [{ name: 'browser', status: 'connected', source: 'skill:ui-preview' }]);
  assert.ok(init.tools.includes('mcp__browser__navigate_page'));
  assert.ok(init.tools.includes('mcp__browser__take_screenshot'));
});

test('execute mode persists threads that can be listed and shown', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();

  const run = runAmp(['--execute', 'remember the frobnicator migration plan', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const list = runAmp(['threads', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, new RegExp(`${threadId}\\s+active\\s+remember the frobnicator migration plan`));

  const show = runAmp(['threads', 'show', threadId], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, new RegExp(`https://ampcode.com/threads/${threadId}`));
  assert.match(show.stdout, /user: remember the frobnicator migration plan/);
});

test('usage reports local estimated usage from persisted threads', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');

  const run = runAmp(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);

  const usage = runAmp(['usage'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(usage.status, 0, usage.stderr);
  assert.match(usage.stdout, /remote_balance: unavailable \(local recreation\)/);
  assert.match(usage.stdout, /threads: 1/);
  assert.match(usage.stdout, /turns: 1/);
  assert.match(usage.stdout, /input_tokens_estimate: 3/);
  assert.match(usage.stdout, /output_tokens_estimate: 1/);
});

test('threads search finds matching prompts and archive hides threads from active list', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');

  const run = runAmp(['--execute', 'investigate indexing logic in src/server/index.ts', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const search = runAmp(['threads', 'search', 'indexing'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, new RegExp(threadId));

  const archive = runAmp(['threads', 'archive', threadId], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(archive.status, 0, archive.stderr);
  assert.match(archive.stdout, /Archived thread/);

  const active = runAmp(['threads', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(active.status, 0, active.stderr);
  assert.doesNotMatch(active.stdout, new RegExp(threadId));

  const archived = runAmp(['threads', 'list', '--archived'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(archived.status, 0, archived.stderr);
  assert.match(archived.stdout, new RegExp(`${threadId}\\s+archived`));
});

test('thread references by @id add prior thread context to execute prompts', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');

  const first = runAmp(['--execute', 'the migration codename is quartz-river', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout.trim().split('\n').at(-1)).session_id;

  const second = runAmp(['--execute', `what codename was mentioned in @${threadId}?`], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /quartz-river/);
});

test('threads continue appends execute-mode turns to the latest active thread', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');

  const first = runAmp(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout.trim().split('\n').at(-1)).session_id;

  const continued = runAmp(['threads', 'continue', '--execute', 'now add 8 to that', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(continued.status, 0, continued.stderr);
  const messages = continued.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.type), ['system', 'user', 'assistant', 'result']);
  assert.equal(messages[0].session_id, threadId);
  assert.equal(messages[2].message.content[0].text, '12');
  assert.equal(messages[3].result, '12');
  assert.equal(messages[3].session_id, threadId);

  const show = runAmp(['threads', 'show', threadId], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /user: what is 2\+2\?/);
  assert.match(show.stdout, /assistant: 4/);
  assert.match(show.stdout, /user: now add 8 to that/);
  assert.match(show.stdout, /assistant: 12/);
});

test('threads handoff drafts a new focused prompt from an existing thread', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');

  const run = runAmp(['--execute', 'phase one: add parser tests before implementation', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const handoff = runAmp(['threads', 'handoff', threadId, '--goal', 'execute phase two'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(handoff.status, 0, handoff.stderr);
  assert.match(handoff.stdout, /Handoff from parent thread/);
  assert.match(handoff.stdout, new RegExp(threadId));
  assert.match(handoff.stdout, /execute phase two/);
  assert.match(handoff.stdout, /phase one: add parser tests before implementation/);
});

test('threads report creates a diagnostic report id for support handoff', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'amp-home-'));
  const xdg = path.join(home, '.config');

  const run = runAmp(['--execute', 'diagnose flaky cli startup', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const report = runAmp(['threads', 'report', threadId], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /diagnostic_report_id: R-/);
  assert.match(report.stdout, new RegExp(`thread_id: ${threadId}`));
});
