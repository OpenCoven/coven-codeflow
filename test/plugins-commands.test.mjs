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
