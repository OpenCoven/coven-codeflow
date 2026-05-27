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
