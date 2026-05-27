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
