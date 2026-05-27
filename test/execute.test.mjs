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

test('execute mode answers a prompt and can inspect markdown files in cwd', async () => {
  const cwd = await makeWorkspace();

  const result = runCovenCode(['-x', 'what files in this folder are markdown files? Print only the filenames.'], { cwd });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'AGENTS.md\nREADME.md');
});

test('execute mode combines stdin with a prompt', async () => {
  const result = runCovenCode(['--execute', 'which colorscheme is used?'], {
    input: 'set background=dark\ncolorscheme gruvbox\n',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /gruvbox/);
});

test('execute mode expands @file mentions from relative, absolute, and home paths', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const cwd = await makeWorkspace();
  await mkdir(path.join(cwd, 'docs'), { recursive: true });
  await writeFile(path.join(cwd, 'docs', 'plan.md'), '# Launch Plan\ncodename: ember-maple\n');
  await writeFile(path.join(cwd, 'Makefile'), 'codename: build-cedar\n');
  await writeFile(path.join(home, 'personal.md'), '# Personal Notes\ncodename: home-signal\n');

  const relative = runCovenCode(['--execute', 'what codename is in @docs/plan.md?'], {
    cwd,
    env: { HOME: home },
  });
  assert.equal(relative.status, 0, relative.stderr);
  assert.match(relative.stdout, /ember-maple/);

  const absolute = runCovenCode(['--execute', `what codename is in @${path.join(cwd, 'docs', 'plan.md')}?`], {
    cwd,
    env: { HOME: home },
  });
  assert.equal(absolute.status, 0, absolute.stderr);
  assert.match(absolute.stdout, /ember-maple/);

  const extensionless = runCovenCode(['--execute', 'what codename is in @Makefile?'], {
    cwd,
    env: { HOME: home },
  });
  assert.equal(extensionless.status, 0, extensionless.stderr);
  assert.match(extensionless.stdout, /build-cedar/);

  const homeMention = runCovenCode(['--execute', 'what codename is in @~/personal.md?'], {
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

  const result = runCovenCode(['--execute', 'list the codenames in @docs/*.md'], { cwd });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'amber-fern\nriver-bell');
});

test('covenCode.fuzzy.alwaysIncludePaths includes gitignored files in glob @file mentions', async () => {
  const cwd = await makeWorkspace();
  await mkdir(path.join(cwd, 'src'), { recursive: true });
  await mkdir(path.join(cwd, 'dist'), { recursive: true });
  await mkdir(path.join(cwd, '.coven-code'), { recursive: true });
  await writeFile(path.join(cwd, '.gitignore'), 'dist/\n');
  await writeFile(path.join(cwd, 'src', 'visible.md'), 'codename: visible-fern\n');
  await writeFile(path.join(cwd, 'dist', 'generated.md'), 'codename: generated-river\n');

  const hidden = runCovenCode(['--execute', 'list the codenames in @**/*.md'], { cwd });
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.equal(hidden.stdout.trim(), 'visible-fern');

  await writeFile(path.join(cwd, '.coven-code', 'settings.json'), JSON.stringify({
    'covenCode.fuzzy.alwaysIncludePaths': ['dist/**'],
  }));

  const included = runCovenCode(['--execute', 'list the codenames in @**/*.md'], { cwd });
  assert.equal(included.status, 0, included.stderr);
  assert.equal(included.stdout.trim(), 'generated-river\nvisible-fern');
});

test('execute mode truncates text @file mentions and ignores binary files', async () => {
  const cwd = await makeWorkspace();
  await mkdir(path.join(cwd, 'docs'), { recursive: true });
  const longLines = Array.from({ length: 501 }, (_, index) => (
    index === 500 ? 'codename: hidden-after-limit' : `line-${String(index + 1).padStart(3, '0')} ${'x'.repeat(2100)}`
  ));
  await writeFile(path.join(cwd, 'docs', 'long.md'), `${longLines.join('\n')}\n`);
  await writeFile(path.join(cwd, 'docs', 'binary.bin'), Buffer.from([0x63, 0x6f, 0x64, 0x65, 0x6e, 0x61, 0x6d, 0x65, 0x3a, 0x20, 0x62, 0x69, 0x6e, 0x61, 0x72, 0x79, 0x2d, 0x73, 0x65, 0x63, 0x72, 0x65, 0x74, 0x00]));

  const longResult = runCovenCode(['--execute', 'what codename is in @docs/long.md?'], { cwd });
  assert.equal(longResult.status, 0, longResult.stderr);
  assert.match(longResult.stdout, /No codename was found/);

  const binaryResult = runCovenCode(['--execute', 'what codename is in @docs/binary.bin?'], { cwd });
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

  const result = runCovenCode(['--execute', 'what image file is mentioned in @images/sample.png?'], { cwd });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'sample.png image/png 12 bytes');
});

test('execute mode can invoke an allowed toolbox tool', async () => {
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
    agent: process.env.AGENT,
    threadId: process.env.COVEN_CODE_THREAD_ID,
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

  const result = runCovenCode(['--execute', 'use tb__context_dump --message hello'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_TOOLBOX: toolsDir },
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.action, 'execute');
  assert.equal(output.agent, 'coven-code');
  assert.match(output.threadId, /^T-/);
  assert.equal(output.message, 'hello');
});

test('execute mode honors delegated toolbox permission decisions', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const binDir = path.join(home, 'bin');
  const toolsDir = path.join(home, 'tools');
  const decisionPath = path.join(home, 'delegate-record.json');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(toolsDir, { recursive: true });

  const helperPath = path.join(binDir, 'coven-code-permission-helper');
  await writeFile(helperPath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  writeFileSync(process.env.DECISION_PATH, JSON.stringify({
    input: JSON.parse(input),
    agent: process.env.AGENT,
    toolName: process.env.AGENT_TOOL_NAME,
    threadId: process.env.COVEN_CODE_THREAD_ID,
    agentThreadId: process.env.AGENT_THREAD_ID
  }));
  process.exit(0);
});
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
  console.log(JSON.stringify({ message: payload.message, threadId: process.env.COVEN_CODE_THREAD_ID }));
});
`);
  await chmod(toolPath, 0o755);
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.permissions': [
      { action: 'delegate', to: 'coven-code-permission-helper', tool: 'tb__context_dump' },
    ],
  }));

  const result = runCovenCode(['--execute', 'use tb__context_dump --message hello'], {
    env: {
      XDG_CONFIG_HOME: xdg,
      HOME: home,
      COVEN_CODE_TOOLBOX: toolsDir,
      DECISION_PATH: decisionPath,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const toolOutput = JSON.parse(result.stdout);
  assert.equal(toolOutput.message, 'hello');
  assert.match(toolOutput.threadId, /^T-/);
  assert.deepEqual(JSON.parse(await readFile(decisionPath, 'utf8')), {
    input: { message: 'hello' },
    agent: 'coven-code',
    toolName: 'tb__context_dump',
    threadId: toolOutput.threadId,
    agentThreadId: toolOutput.threadId,
  });
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

  const result = runCovenCode(['--execute', 'what codename is in the guidance files?'], { cwd: workspace });

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

  const readme = runCovenCode(['--execute', 'list the codenames from guidance for @README.md'], { cwd: workspace });
  assert.equal(readme.status, 0, readme.stderr);
  assert.equal(readme.stdout.trim(), 'common-lantern');

  const ts = runCovenCode(['--execute', 'list the codenames from guidance for @src/app.ts'], { cwd: workspace });
  assert.equal(ts.status, 0, ts.stderr);
  assert.equal(ts.stdout.trim(), 'common-lantern\nts-lantern');
});

test('execute mode includes subtree AGENTS.md when reading files below it', async () => {
  const workspace = await makeWorkspace();
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# Fixture\n');
  await writeFile(path.join(workspace, 'src', 'app.ts'), 'export const app = true;\n');
  await writeFile(path.join(workspace, 'src', 'AGENTS.md'), 'codename: subtree-lantern\n');

  const readme = runCovenCode(['--execute', 'what codename is in guidance for @README.md?'], { cwd: workspace });
  assert.equal(readme.status, 0, readme.stderr);
  assert.match(readme.stdout, /No codename was found/);

  const source = runCovenCode(['--execute', 'what codename is in guidance for @src/app.ts?'], { cwd: workspace });
  assert.equal(source.status, 0, source.stderr);
  assert.equal(source.stdout.trim(), 'subtree-lantern');
});

test('execute mode can invoke a plugin-registered tool', async () => {
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

  const result = runCovenCode(['--dangerously-allow-all', '--execute', 'use project_status --format short'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'clean', format: 'short' });
});

test('built-in Bash git commits include Coven Code thread trailers by default', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# fixture\n');

  assert.equal(runGit(['init'], { cwd: workspace }).status, 0);
  assert.equal(runGit(['add', 'README.md'], { cwd: workspace }).status, 0);

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use Bash --command "git commit -m initial"',
    '--stream-json',
  ], {
    cwd: workspace,
    env: {
      XDG_CONFIG_HOME: xdg,
      HOME: home,
      GIT_AUTHOR_NAME: 'Coven Code Test',
      GIT_AUTHOR_EMAIL: 'coven-code-test@example.com',
      GIT_COMMITTER_NAME: 'Coven Code Test',
      GIT_COMMITTER_EMAIL: 'coven-code-test@example.com',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const threadId = JSON.parse(result.stdout.trim().split('\n').at(-1)).session_id;
  const log = runGit(['log', '-1', '--pretty=%B'], { cwd: workspace });
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, new RegExp(`Coven-Code-Thread: https://coven-code\\.local/threads/${threadId}`));
  assert.doesNotMatch(log.stdout, /Co-authored-by:/);
});

test('built-in Bash git commit trailers respect Coven Code git settings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.git.commit.thread.enabled': false,
    'covenCode.git.commit.coauthor.enabled': false,
  }));
  await writeFile(path.join(workspace, 'README.md'), '# fixture\n');

  assert.equal(runGit(['init'], { cwd: workspace }).status, 0);
  assert.equal(runGit(['add', 'README.md'], { cwd: workspace }).status, 0);

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use Bash --command "git commit -m initial"',
  ], {
    cwd: workspace,
    env: {
      XDG_CONFIG_HOME: xdg,
      HOME: home,
      GIT_AUTHOR_NAME: 'Coven Code Test',
      GIT_AUTHOR_EMAIL: 'coven-code-test@example.com',
      GIT_COMMITTER_NAME: 'Coven Code Test',
      GIT_COMMITTER_EMAIL: 'coven-code-test@example.com',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const log = runGit(['log', '-1', '--pretty=%B'], { cwd: workspace });
  assert.equal(log.status, 0, log.stderr);
  assert.doesNotMatch(log.stdout, /Coven-Code-Thread:/);
  assert.doesNotMatch(log.stdout, /Co-authored-by:/);
});

test('execute mode can undo the latest built-in edit_file change across a continued thread', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'undo-events.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, 'notes.md'), 'project codename: amber-signal\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'undo-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'undo_edit') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'undo_edit') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
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

  const edit = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use edit_file --path notes.md --old amber-signal --new jade-signal',
    '--stream-json',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(edit.status, 0, edit.stderr);
  assert.equal(await readFile(path.join(workspace, 'notes.md'), 'utf8'), 'project codename: jade-signal\n');
  const threadId = JSON.parse(edit.stdout.trim().split('\n').at(-1)).session_id;

  const undo = runCovenCode([
    '--dangerously-allow-all',
    '--continue',
    threadId,
    '--execute',
    'use undo_edit --path notes.md',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(undo.status, 0, undo.stderr);
  assert.equal(undo.stdout.trim(), 'Undid edit to notes.md');
  assert.equal(await readFile(path.join(workspace, 'notes.md'), 'utf8'), 'project codename: amber-signal\n');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const input = { path: 'notes.md' };
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.equal(events[0].threadId, threadId);
  assert.deepEqual(events[0], {
    type: 'call',
    toolUseID: events[0].toolUseID,
    threadId,
    input,
  });
  assert.deepEqual(events[1], {
    type: 'result',
    toolUseID: events[0].toolUseID,
    threadId,
    input,
    status: 'done',
    output: 'Undid edit to notes.md',
  });
});

test('execute mode can invoke built-in mermaid to emit a diagram block', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const env = { XDG_CONFIG_HOME: xdg, HOME: home };

  const list = runCovenCode(['tools', 'list'], { env });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^mermaid\s+built-in\s+Renders a Mermaid diagram/m);

  const result = runCovenCode([
    '--execute',
    'use mermaid --code "graph TD; A[CLI] --> B[Agent]"',
    '--stream-json',
  ], { env });
  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const toolUse = messages.find((message) => message.type === 'assistant' && message.message.content[0]?.type === 'tool_use')
    .message.content[0];
  assert.equal(toolUse.name, 'mermaid');
  assert.deepEqual(toolUse.input, { code: 'graph TD; A[CLI] --> B[Agent]' });
  assert.equal(messages.at(-1).result, '```mermaid\ngraph TD; A[CLI] --> B[Agent]\n```');
});

test('execute mode can invoke built-in librarian to research workspace code', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src', 'validation.ts'), 'export const note = "zod validation path";\n');

  const result = runCovenCode([
    '--execute',
    'use librarian --query "zod validation"',
    '--stream-json',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(messages[0].tools.includes('librarian'));
  assert.equal(messages.at(-1).result, [
    'Librarian search: zod validation',
    'scope: current workspace',
    'matches:',
    '- src/validation.ts:1: export const note = "zod validation path";',
  ].join('\n'));
});

test('execute mode can invoke built-in painter to generate a local image artifact', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(workspace, { recursive: true });

  const result = runCovenCode([
    '--execute',
    'use painter --prompt "dark terminal icon with cyan cursor" --output assets/icon.png',
    '--stream-json',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(messages[0].tools.includes('painter'));
  assert.equal(messages.at(-1).result, [
    'Generated image: assets/icon.png',
    'media_type: image/png',
    'prompt: dark terminal icon with cyan cursor',
  ].join('\n'));
  const image = await readFile(path.join(workspace, 'assets', 'icon.png'));
  assert.deepEqual([...image.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('execute mode can invoke built-in look_at to inspect a local media file', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, 'images'), { recursive: true });
  await writeFile(path.join(workspace, 'images', 'sample.png'), Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
  ]));

  const result = runCovenCode([
    '--execute',
    'use look_at --path images/sample.png --goal "identify media type"',
    '--stream-json',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(messages[0].tools.includes('look_at'));
  assert.equal(messages.at(-1).result, [
    'Looked at: images/sample.png',
    'media_type: image/png',
    'bytes: 12',
    'goal: identify media type',
  ].join('\n'));
});

test('execute mode can invoke built-in finder to search prior threads', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = path.join(home, 'repo');
  const marker = path.join(workspace, 'finder-events.jsonl');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'finder-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'finder') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'finder') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
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

  const first = runCovenCode(['--execute', 'remember the amber-signal release plan', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(first.status, 0, first.stderr);
  const firstThreadId = JSON.parse(first.stdout.trim().split('\n').at(-1)).session_id;

  const second = runCovenCode(['--execute', 'remember the jade-signal migration plan', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(second.status, 0, second.stderr);
  const secondThreadId = JSON.parse(second.stdout.trim().split('\n').at(-1)).session_id;

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use finder --query amber-signal --limit 3',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${firstThreadId}\\s+active\\s+private\\s+-\\s+remember the amber-signal release plan`));
  assert.doesNotMatch(result.stdout, new RegExp(secondThreadId));
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const input = { query: 'amber-signal', limit: 3 };
  assert.match(events[0].toolUseID, /^toolu_/);
  assert.match(events[0].threadId, /^T-/);
  assert.deepEqual(events[0], {
    type: 'call',
    toolUseID: events[0].toolUseID,
    threadId: events[0].threadId,
    input,
  });
  assert.equal(events[1].type, 'result');
  assert.equal(events[1].toolUseID, events[0].toolUseID);
  assert.equal(events[1].threadId, events[0].threadId);
  assert.deepEqual(events[1].input, input);
  assert.match(events[1].output, new RegExp(firstThreadId));
  assert.equal(events[1].status, 'done');
});

test('execute mode can invoke built-in find_thread to search prior threads', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const first = runCovenCode(['--execute', 'remember the amber-signal release plan', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(first.status, 0, first.stderr);
  const firstThreadId = JSON.parse(first.stdout.trim().split('\n').at(-1)).session_id;

  const second = runCovenCode(['--execute', 'remember the jade-signal migration plan', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(second.status, 0, second.stderr);
  const secondThreadId = JSON.parse(second.stdout.trim().split('\n').at(-1)).session_id;

  const result = runCovenCode(['--execute', 'use find_thread --query amber-signal --limit 3'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${firstThreadId}\\s+active\\s+private\\s+-\\s+remember the amber-signal release plan`));
  assert.doesNotMatch(result.stdout, new RegExp(secondThreadId));
});

test('execute mode can invoke an allowed local MCP tool', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const marker = path.join(workspace, 'mcp-tool-events.jsonl');
  const serverPath = path.join(home, 'mcp-server.mjs');
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'mcp-tool-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'mcp__context7__resolve-library-id') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'mcp__context7__resolve-library-id') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
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
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      context7: {
        command: process.execPath,
        args: [serverPath],
      },
    },
    'covenCode.permissions': [
      { action: 'allow', tool: 'mcp__context7__resolve-library-id' },
    ],
  }));

  const result = runCovenCode(['--execute', 'use mcp__context7__resolve-library-id --libraryName react'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'resolved:react');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const input = { libraryName: 'react' };
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
    output: 'resolved:react',
  });
});

test('execute mode can invoke built-in read_mcp_resource for approved local MCP servers', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const marker = path.join(workspace, 'read-mcp-resource-events.jsonl');
  const serverPath = path.join(home, 'mcp-resource-server.mjs');
  await mkdir(path.join(workspace, '.coven-code', 'plugins'), { recursive: true });
  await writeFile(path.join(workspace, '.coven-code', 'plugins', 'read-mcp-resource-observer.ts'), `
import { appendFileSync } from 'node:fs';

export default function (covenCode) {
  covenCode.on('tool.call', async (event) => {
    if (event.tool === 'read_mcp_resource') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      type: 'call',
      toolUseID: event.toolUseID,
      threadId: event.thread.id,
      input: event.input,
    }) + '\\n');
  });
  covenCode.on('tool.result', async (event) => {
    if (event.tool === 'read_mcp_resource') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
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
    if (message.method === 'resources/read') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          contents: [
            { uri: message.params.uri, mimeType: 'text/plain', text: 'resource:' + message.params.uri }
          ]
        }
      }) + '\\n');
      process.exit(0);
    }
  }
});
`);
  await chmod(serverPath, 0o755);
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      docs: {
        command: process.execPath,
        args: [serverPath],
      },
    },
  }));

  const result = runCovenCode([
    '--dangerously-allow-all',
    '--execute',
    'use read_mcp_resource --server docs --uri file://docs/guide.md',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'resource:file://docs/guide.md');
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const input = { server: 'docs', uri: 'file://docs/guide.md' };
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
    output: 'resource:file://docs/guide.md',
  });
});

test('execute mode persists threads that can be listed and shown', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(workspace, '.coven-code'), { recursive: true });
  await writeFile(path.join(workspace, '.coven-code', 'settings.json'), JSON.stringify({
    'covenCode.defaultVisibility': { default: 'private' },
  }));

  const run = runCovenCode(['--execute', 'remember the frobnicator migration plan', '--stream-json'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const list = runCovenCode(['threads', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, new RegExp(`${threadId}\\s+active\\s+private\\s+-\\s+remember the frobnicator migration plan`));

  const show = runCovenCode(['threads', 'show', threadId], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, new RegExp(`https://coven-code\\.local/threads/${threadId}`));
  assert.match(show.stdout, /visibility: private/);
  assert.match(show.stdout, /labels: -/);
  assert.match(show.stdout, /user: remember the frobnicator migration plan/);
});

test('execute mode stores thread labels, visibility override, and archive flag', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  await mkdir(path.join(workspace, '.coven-code'), { recursive: true });
  await writeFile(path.join(workspace, '.coven-code', 'settings.json'), JSON.stringify({
    'covenCode.defaultVisibility': { default: 'workspace' },
  }));

  const run = runCovenCode([
    '--execute',
    'summarize release automation',
    '--stream-json',
    '--label',
    'sdk',
    '--label',
    'summary',
    '--visibility',
    'public',
    '--archive',
  ], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const active = runCovenCode(['threads', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(active.status, 0, active.stderr);
  assert.doesNotMatch(active.stdout, new RegExp(threadId));

  const archived = runCovenCode(['threads', 'list', '--archived'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(archived.status, 0, archived.stderr);
  assert.match(archived.stdout, new RegExp(`${threadId}\\s+archived\\s+public\\s+sdk,summary\\s+summarize release automation`));

  const show = runCovenCode(['threads', 'show', threadId], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /status: archived/);
  assert.match(show.stdout, /visibility: public/);
  assert.match(show.stdout, /labels: sdk, summary/);

  const search = runCovenCode(['threads', 'search', 'summary'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, new RegExp(threadId));
});

test('global --continue resumes latest or explicit threads in execute mode', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const first = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(first.status, 0, first.stderr);
  const firstThreadId = JSON.parse(first.stdout.trim().split('\n').at(-1)).session_id;

  const latest = runCovenCode(['--continue', '--execute', 'now add 8 to that', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(latest.status, 0, latest.stderr);
  const latestMessages = latest.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(latestMessages[0].session_id, firstThreadId);
  assert.equal(latestMessages[3].result, '12');

  const second = runCovenCode(['--execute', 'the migration codename is jade-signal', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(second.status, 0, second.stderr);
  const secondThreadId = JSON.parse(second.stdout.trim().split('\n').at(-1)).session_id;

  const explicit = runCovenCode(['--continue', firstThreadId, '--execute', 'now add 5 to that', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(explicit.status, 0, explicit.stderr);
  const explicitMessages = explicit.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(explicitMessages[0].session_id, firstThreadId);
  assert.equal(explicitMessages[3].result, '17');

  const secondShow = runCovenCode(['threads', 'show', secondThreadId], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(secondShow.status, 0, secondShow.stderr);
  assert.doesNotMatch(secondShow.stdout, /now add 5 to that/);
});
