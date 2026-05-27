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
