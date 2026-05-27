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
