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
