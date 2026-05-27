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
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
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
