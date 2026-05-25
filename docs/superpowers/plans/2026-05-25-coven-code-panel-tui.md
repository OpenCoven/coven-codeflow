# Coven Code Panel TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bare `coven-code` open a keyboard-first panel TUI while preserving execute mode, stream-json mode, command subcommands, and the classic readline REPL escape hatch.

**Architecture:** Extract the existing interactive command behavior from `src/cli/repl.mjs` into `src/cli/interactive-core.mjs`, then have both the classic REPL and new TUI call that shared core. Add `src/cli/tui.mjs` as a full-screen terminal UI controller with a transcript, status rail, tabs, composer, command palette, and deterministic test hooks.

**Tech Stack:** Node.js ESM, Node built-in test runner, existing `runExecute` command engine, ANSI terminal control via Node stdlib for the first TUI pass.

---

## File Structure

- Modify: `src/cli/repl.mjs`
  - Keep classic readline mode.
  - Delegate slash commands, prompt turns, history, editor, and thread helpers to shared interactive-core helpers.
- Create: `src/cli/interactive-core.mjs`
  - Own reusable interactive state and command handling.
  - Export `createInteractiveSession`, `handleInteractiveInput`, `printSlashHelp`, `readEditorPrompt`, `interactiveContinuationThread`, and `runInteractiveTurn`.
- Create: `src/cli/tui.mjs`
  - Own TUI rendering, keyboard handling, command palette state, status rail, tab state, and fallback-safe startup.
  - Export `runTuiInteractive`, `createTuiModel`, `renderTuiFrame`, and `handleTuiKey`.
- Modify: `src/main.mjs`
  - Route bare TTY sessions to `runTuiInteractive`.
  - Route `COVEN_CODE_REPL=1 coven-code` to `runInteractive`.
  - Preserve execute and command dispatch behavior.
- Modify: `test/cli.test.mjs`
  - Add tests for interactive routing, classic REPL escape hatch, core slash command behavior, TUI model behavior, and command compatibility.
- Modify: `README.md`
  - Document the TUI default and classic REPL escape hatch.
- Modify: `docs/CLI.md`
  - Document interactive TUI behavior and unchanged noninteractive behavior.
- Modify: `docs/DEVELOPMENT.md`
  - Document TUI test entry points and manual smoke command.

## Task 1: Extract Shared Interactive Core

**Files:**
- Create: `src/cli/interactive-core.mjs`
- Modify: `src/cli/repl.mjs`
- Test: `test/cli.test.mjs`

- [ ] **Step 1: Write failing tests for shared interactive state**

Append these tests to `test/cli.test.mjs`:

```js
test('interactive core handles mode, reasoning, queue, and new thread slash commands', async () => {
  const { createInteractiveSession, handleInteractiveInput } = await import(pathToFileURL(path.join(repoRoot, 'src', 'cli', 'interactive-core.mjs')));
  const parsed = { mode: 'smart', reasoningEffort: undefined };
  const session = createInteractiveSession(parsed);

  const mode = await handleInteractiveInput(session, '/mode deep');
  assert.equal(mode.kind, 'command');
  assert.deepEqual(mode.lines, ['mode: deep', 'reasoning effort: medium']);
  assert.equal(parsed.mode, 'deep');
  assert.equal(parsed.reasoningEffort, 'medium');

  const reasoning = await handleInteractiveInput(session, '/reasoning next');
  assert.equal(reasoning.kind, 'command');
  assert.deepEqual(reasoning.lines, ['reasoning effort: high']);
  assert.equal(parsed.reasoningEffort, 'high');

  const queued = await handleInteractiveInput(session, '/queue follow up');
  assert.equal(queued.kind, 'command');
  assert.deepEqual(queued.lines, ['queued: follow up']);
  assert.deepEqual(session.queuedMessages, ['follow up']);

  session.thread = { id: 'T-test', messages: [{ role: 'user', content: 'hi' }] };
  const fresh = await handleInteractiveInput(session, '/new');
  assert.equal(fresh.kind, 'command');
  assert.deepEqual(fresh.lines, ['new thread']);
  assert.equal(session.thread, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/cli.test.mjs --test-name-pattern "interactive core handles mode"`

Expected: FAIL with a module-not-found error for `src/cli/interactive-core.mjs`.

- [ ] **Step 3: Create `src/cli/interactive-core.mjs`**

Move the reusable helpers from `src/cli/repl.mjs` into the new module and include this public API:

```js
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AGENT_MODES, CLI_NAME, CONFIG_SUBDIR, REPL_HISTORY_LIMIT } from '../constants.mjs';
import { configDir } from '../settings/paths.mjs';
import { shellQuote, splitShellWords } from '../util/shell.mjs';
import { latestActiveThread, requireThread } from '../threads/store.mjs';
import { runCommand } from './dispatch.mjs';
import { runExecute } from './execute.mjs';
import {
  coerceReasoningEffortForMode,
  nextReasoningEffortForMode,
  reasoningEffortForMode,
} from './reasoning.mjs';

export function createInteractiveSession(parsed, options = {}) {
  return {
    parsed,
    thread: options.thread,
    queuedMessages: [],
    commandRunner: options.commandRunner ?? runCommand,
    executeRunner: options.executeRunner ?? runExecute,
    editorReader: options.editorReader ?? readEditorPrompt,
  };
}

export async function handleInteractiveInput(session, text) {
  if (!text) return { kind: 'empty', lines: [] };
  if (text === '/exit' || text === '/quit') return { kind: 'exit', lines: [] };
  if (text === '/help') return { kind: 'help', lines: slashHelpLines() };
  if (!text.startsWith('/')) {
    session.thread = await runInteractiveTurn(session.parsed, text, session.thread, session.executeRunner);
    while (session.queuedMessages.length > 0) {
      session.thread = await runInteractiveTurn(session.parsed, session.queuedMessages.shift(), session.thread, session.executeRunner);
    }
    return { kind: 'turn', lines: [] };
  }

  const tokens = splitShellWords(text.slice(1));
  const [cmd, ...rest] = tokens;
  if (!cmd) return { kind: 'empty', lines: [] };

  if (cmd === 'mode') {
    const nextMode = rest[0];
    if (!nextMode) return { kind: 'command', lines: [`mode: ${session.parsed.mode}`] };
    if (!AGENT_MODES.includes(nextMode)) return { kind: 'error', lines: [`${CLI_NAME}: Unknown mode: ${nextMode}`] };
    session.parsed.mode = nextMode;
    session.parsed.reasoningEffort = coerceReasoningEffortForMode(session.parsed.mode, session.parsed.reasoningEffort);
    return { kind: 'command', lines: [`mode: ${session.parsed.mode}`, `reasoning effort: ${session.parsed.reasoningEffort}`] };
  }

  if (cmd === 'reasoning') {
    try {
      const nextEffort = rest[0] === 'next'
        ? nextReasoningEffortForMode(session.parsed.mode, session.parsed.reasoningEffort)
        : rest[0];
      session.parsed.reasoningEffort = reasoningEffortForMode(session.parsed.mode, nextEffort ?? session.parsed.reasoningEffort);
      return { kind: 'command', lines: [`reasoning effort: ${session.parsed.reasoningEffort}`] };
    } catch (error) {
      return { kind: 'error', lines: [`${CLI_NAME}: ${error?.message ?? error}`] };
    }
  }

  if (cmd === 'queue') {
    const queued = rest.join(' ').trim();
    if (!queued) return { kind: 'error', lines: [`${CLI_NAME}: /queue requires a prompt`] };
    session.queuedMessages.push(queued);
    return { kind: 'command', lines: [`queued: ${queued}`] };
  }

  if (cmd === 'new') {
    session.thread = undefined;
    return { kind: 'command', lines: ['new thread'] };
  }

  if (cmd === 'continue') {
    try {
      session.thread = interactiveContinuationThread(rest[0]);
      return { kind: 'command', lines: [`continued: ${session.thread.id}`] };
    } catch (error) {
      return { kind: 'error', lines: [`${CLI_NAME}: ${error?.message ?? error}`] };
    }
  }

  if (cmd === `${CLI_NAME}:` && rest.join(' ') === 'help') return { kind: 'help', lines: slashHelpLines() };

  if (cmd === 'editor') {
    const edited = await session.editorReader();
    if (edited) {
      session.thread = await runInteractiveTurn(session.parsed, edited, session.thread, session.executeRunner);
      while (session.queuedMessages.length > 0) {
        session.thread = await runInteractiveTurn(session.parsed, session.queuedMessages.shift(), session.thread, session.executeRunner);
      }
    }
    return { kind: 'command', lines: [] };
  }

  if (cmd === 'edit') {
    try {
      if (!session.thread) throw new Error('No current thread to edit');
      const editTarget = editablePreviousPrompt(session.thread);
      const edited = await session.editorReader(editTarget.prompt);
      if (edited) {
        session.thread.messages = session.thread.messages.slice(0, editTarget.index);
        if (session.thread.messages.length === 0) {
          session.thread.title = edited.split(/\r?\n/).find(Boolean)?.slice(0, 120) || '(empty prompt)';
        }
        session.thread = await runInteractiveTurn(session.parsed, edited, session.thread, session.executeRunner);
        while (session.queuedMessages.length > 0) {
          session.thread = await runInteractiveTurn(session.parsed, session.queuedMessages.shift(), session.thread, session.executeRunner);
        }
      }
      return { kind: 'command', lines: [] };
    } catch (error) {
      return { kind: 'error', lines: [`${CLI_NAME}: ${error?.message ?? error}`] };
    }
  }

  if (cmd === 'thread:' && rest.join(' ') === 'archive and quit') {
    try {
      if (!session.thread) throw new Error('No current thread to archive');
      await session.commandRunner('threads', ['archive', session.thread.id], session.parsed, '');
      return { kind: 'exit', lines: [] };
    } catch (error) {
      return { kind: 'error', lines: [`${CLI_NAME}: ${error?.message ?? error}`] };
    }
  }

  if (cmd === 'thread:' && rest[0] === 'set' && rest[1] === 'visibility') {
    try {
      if (!session.thread) throw new Error('No current thread to update');
      await session.commandRunner('threads', ['visibility', session.thread.id, ...rest.slice(2)], session.parsed, '');
      return { kind: 'command', lines: [] };
    } catch (error) {
      return { kind: 'error', lines: [`${CLI_NAME}: ${error?.message ?? error}`] };
    }
  }

  if (cmd === 'feedback:' && rest.join(' ') === 'send report with diagnostics') {
    try {
      if (!session.thread) throw new Error('No current thread to report');
      await session.commandRunner('threads', ['report', session.thread.id], session.parsed, '');
      return { kind: 'command', lines: [] };
    } catch (error) {
      return { kind: 'error', lines: [`${CLI_NAME}: ${error?.message ?? error}`] };
    }
  }

  try {
    if (cmd === 'skill:') await session.commandRunner('skill', rest, session.parsed, '');
    else if (cmd === 'plugins:') await session.commandRunner('plugins', rest, session.parsed, '');
    else await session.commandRunner(cmd, rest, session.parsed, '');
    return { kind: 'command', lines: [] };
  } catch (error) {
    if (String(error?.message ?? '').startsWith('Unknown command:')) {
      try {
        await session.commandRunner('plugins', ['run', cmd], session.parsed, '');
        return { kind: 'command', lines: [] };
      } catch (pluginError) {
        if (!String(pluginError?.message ?? '').startsWith('Unknown plugin command:')) throw pluginError;
      }
    }
    return { kind: 'error', lines: [`${CLI_NAME}: ${error?.message ?? error}`] };
  }
}

export function slashHelpLines() {
  return [
    'Slash commands:',
    '  /exit, /quit          leave the REPL',
    '  /help                 show this message',
    `  /${CLI_NAME}: help`,
    '                         show command-palette help',
    '  /mode [name]          show or set mode: smart, deep, rush, large',
    '  /reasoning [level|next]',
    '                         show, set, or cycle reasoning effort',
    '  /new                  start a fresh thread',
    '  /continue [thread-id] continue the latest active thread or a specific thread',
    '  /queue <prompt>       send a follow-up prompt after the next turn',
    '  /editor               compose the next prompt in $EDITOR',
    '  /edit                 edit the previous prompt in $EDITOR',
    '  /ide connect          connect or inspect local IDE integration',
    '  /skill: list          list installed skills',
    '  /plugins: reload      reload project and user plugins',
    '  /thread: archive and quit',
    '                         archive the current thread and leave the REPL',
    '  /thread: set visibility <level>',
    '                         set current thread visibility',
    '  /feedback: send report with diagnostics',
    '                         create a diagnostic report for the current thread',
    `  /<subcommand> [args]  run any top-level ${CLI_NAME} subcommand (e.g. /tools list)`,
    'End a line with `\\` to continue the prompt onto the next line.',
    'Anything else is sent as a one-turn prompt.',
    '',
    'Keybindings:',
    '  Ctrl+P                open the command palette',
    '  Ctrl+E                open the current prompt in $EDITOR',
    '  Ctrl+M                switch agent modes',
    '  Ctrl+R                cycle reasoning effort',
    '  Tab                   cycle TUI tabs',
    '  Esc                   close overlays',
    '  @                     mention files',
  ];
}

export function printSlashHelp() {
  for (const line of slashHelpLines()) console.log(line);
}

export async function readEditorPrompt(initialText = '') {
  const editor = process.env.EDITOR || process.env.VISUAL;
  if (!editor) {
    console.error(`${CLI_NAME}: /editor requires $EDITOR or $VISUAL`);
    return '';
  }
  const file = path.join(tmpdir(), `${CONFIG_SUBDIR}-prompt-${process.pid}-${Date.now()}.md`);
  try {
    await writeFile(file, initialText);
    const result = spawnSync(`${editor} ${shellQuote(file)}`, {
      stdio: 'inherit',
      shell: true,
    });
    if (result.error) {
      console.error(`${CLI_NAME}: Unable to run editor: ${result.error.message}`);
      return '';
    }
    if ((result.status ?? 0) !== 0) {
      console.error(`${CLI_NAME}: Editor exited with status ${result.status}`);
      return '';
    }
    return (await readFile(file, 'utf8')).trim();
  } finally {
    await unlink(file).catch(() => {});
  }
}

export function editablePreviousPrompt(thread) {
  const index = (thread.messages ?? []).findLastIndex((message) => (
    message.role === 'user' && typeof message.content === 'string'
  ));
  if (index === -1) throw new Error('No previous user prompt to edit');
  return { index, prompt: thread.messages[index].content };
}

export function interactiveContinuationThread(threadId) {
  if (threadId) return requireThread(threadId);
  const thread = latestActiveThread();
  if (!thread) throw new Error('No active thread to continue');
  return thread;
}

export async function runInteractiveTurn(parsed, text, thread, executeRunner = runExecute) {
  try {
    return await executeRunner(
      { ...parsed, execute: true, prompt: text, streamJson: false, streamJsonThinking: false, streamJsonInput: false },
      '',
      { thread },
    );
  } catch (error) {
    console.error(`${CLI_NAME}: ${error?.message ?? error}`);
    return thread;
  }
}

export function replHistoryFile() {
  return process.env.COVEN_CODE_REPL_HISTORY_FILE
    || path.join(configDir(), CONFIG_SUBDIR, 'repl_history');
}

export function loadReplHistory() {
  if (process.env.COVEN_CODE_REPL_HISTORY === '0') return [];
  try {
    return readFileSync(replHistoryFile(), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-REPL_HISTORY_LIMIT)
      .reverse();
  } catch {
    return [];
  }
}

export async function appendReplHistory(line) {
  if (process.env.COVEN_CODE_REPL_HISTORY === '0') return;
  try {
    const file = replHistoryFile();
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${line}\n`);
  } catch {
    // history must never break the REPL
  }
}
```

- [ ] **Step 4: Update `src/cli/repl.mjs` to delegate**

Replace embedded command handling with `createInteractiveSession` and `handleInteractiveInput`. Keep readline buffering and prompts in `repl.mjs`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/cli.test.mjs --test-name-pattern "interactive core handles mode"`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/repl.mjs src/cli/interactive-core.mjs test/cli.test.mjs
git commit -m "refactor: extract coven-code interactive core"
```

## Task 2: Add Interactive Routing

**Files:**
- Modify: `src/main.mjs`
- Create: `src/cli/tui.mjs`
- Test: `test/cli.test.mjs`

- [ ] **Step 1: Write failing routing tests**

Append tests that import `selectInteractiveRunner` from `src/main.mjs`:

```js
test('interactive routing chooses tui by default for tty sessions and repl when requested', async () => {
  const { selectInteractiveRunner } = await import(pathToFileURL(path.join(repoRoot, 'src', 'main.mjs')));

  assert.equal(selectInteractiveRunner({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    env: {},
  }), 'tui');

  assert.equal(selectInteractiveRunner({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    env: { COVEN_CODE_REPL: '1' },
  }), 'repl');

  assert.equal(selectInteractiveRunner({
    stdinIsTTY: false,
    stdoutIsTTY: true,
    env: {},
  }), 'repl');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/cli.test.mjs --test-name-pattern "interactive routing chooses tui"`

Expected: FAIL because `selectInteractiveRunner` is not exported.

- [ ] **Step 3: Add minimal `src/cli/tui.mjs`**

Create a first stub that delegates to the classic REPL until the real TUI task:

```js
import { runInteractive } from './repl.mjs';

export async function runTuiInteractive(parsed, initialInput = '') {
  return runInteractive(parsed, initialInput);
}
```

- [ ] **Step 4: Export `selectInteractiveRunner` and wire routing in `src/main.mjs`**

Add:

```js
import { runTuiInteractive } from './cli/tui.mjs';
```

Add:

```js
export function selectInteractiveRunner({ stdinIsTTY, stdoutIsTTY, env }) {
  if (env.COVEN_CODE_REPL === '1') return 'repl';
  if (stdinIsTTY && stdoutIsTTY) return 'tui';
  return 'repl';
}
```

Replace the interactive branch with:

```js
if (process.stdout.isTTY && (process.stdin.isTTY || stdin.length > 0)) {
  const runner = selectInteractiveRunner({
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    env: process.env,
  });
  if (runner === 'tui') await runTuiInteractive(parsed, stdin);
  else await runInteractive(parsed, stdin);
  return;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/cli.test.mjs --test-name-pattern "interactive routing chooses tui"`

Expected: PASS.

- [ ] **Step 6: Verify execute mode still works**

Run: `node ./bin/coven-code.mjs -x "what is 2+2?"`

Expected: `4`.

- [ ] **Step 7: Commit**

```bash
git add src/main.mjs src/cli/tui.mjs test/cli.test.mjs
git commit -m "feat: route coven-code tty sessions to tui"
```

## Task 3: Build the TUI Model and Renderer

**Files:**
- Modify: `src/cli/tui.mjs`
- Test: `test/cli.test.mjs`

- [ ] **Step 1: Write failing model/render tests**

Append:

```js
test('tui model renders panel layout with transcript tabs status rail and composer', async () => {
  const { createTuiModel, renderTuiFrame } = await import(pathToFileURL(path.join(repoRoot, 'src', 'cli', 'tui.mjs')));

  const model = createTuiModel({
    version: '0.0.0-test',
    mode: 'smart',
    reasoningEffort: 'medium',
    threadId: 'T-test',
    toolCount: 18,
  });
  model.transcript.push({ role: 'user', text: 'hello' });
  model.composer = 'what is 2+2?';

  const frame = renderTuiFrame(model, { columns: 82, rows: 24, color: false });

  assert.match(frame, /Coven Code 0\.0\.0-test/);
  assert.match(frame, /chat\s+tools\s+threads\s+config\s+help/);
  assert.match(frame, /you/);
  assert.match(frame, /hello/);
  assert.match(frame, /thread: T-test/);
  assert.match(frame, /mode: smart/);
  assert.match(frame, /> what is 2\+2\?/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/cli.test.mjs --test-name-pattern "tui model renders"`

Expected: FAIL because `createTuiModel` and `renderTuiFrame` are not exported.

- [ ] **Step 3: Implement model and renderer**

Implement:

```js
import { CLI_NAME, VERSION } from '../constants.mjs';
import { createInteractiveSession, handleInteractiveInput, slashHelpLines } from './interactive-core.mjs';

const TABS = ['chat', 'tools', 'threads', 'config', 'help'];

export function createTuiModel(options = {}) {
  return {
    version: options.version ?? VERSION,
    mode: options.mode ?? 'smart',
    reasoningEffort: options.reasoningEffort ?? 'medium',
    threadId: options.threadId ?? 'new thread',
    toolCount: options.toolCount ?? 0,
    queueCount: options.queueCount ?? 0,
    activeTab: options.activeTab ?? 'chat',
    paletteOpen: false,
    composer: '',
    transcript: [],
    status: 'idle',
  };
}

export function renderTuiFrame(model, size = {}) {
  const columns = Math.max(50, size.columns ?? process.stdout.columns ?? 80);
  const rows = Math.max(16, size.rows ?? process.stdout.rows ?? 24);
  const width = columns;
  const bodyRows = rows - 7;
  const divider = '-'.repeat(width);
  const tabs = TABS.map((tab) => tab === model.activeTab ? `[${tab}]` : tab).join(' ');
  const transcript = renderTranscript(model, Math.max(3, bodyRows - 4), width - 24);
  const status = [
    `thread: ${model.threadId}`,
    `mode: ${model.mode}`,
    `reasoning: ${model.reasoningEffort}`,
    `queued: ${model.queueCount}`,
    `tools: ${model.toolCount}`,
    `status: ${model.status}`,
  ];
  const body = mergeColumns(transcript, status, width);
  const lines = [
    `Coven Code ${model.version}`.slice(0, width),
    tabs.slice(0, width),
    divider,
    ...body,
    divider,
    `> ${model.composer}`.slice(0, width),
  ];
  return lines.slice(0, rows).join('\n');
}

function renderTranscript(model, limit, width) {
  if (model.activeTab === 'help') return slashHelpLines().slice(0, limit).map((line) => line.slice(0, width));
  if (model.activeTab !== 'chat') return [`${model.activeTab} panel`, 'Use slash commands or Ctrl-P palette actions.'];
  const entries = model.transcript.slice(-limit).flatMap((entry) => [
    `${entry.role}:`.slice(0, width),
    ...String(entry.text).split(/\r?\n/).map((line) => line.slice(0, width)),
  ]);
  return entries.length > 0 ? entries.slice(-limit) : ['Ready. Type a prompt or /help.'];
}

function mergeColumns(leftLines, rightLines, width) {
  const rightWidth = Math.min(22, Math.floor(width * 0.32));
  const leftWidth = width - rightWidth - 3;
  const count = Math.max(leftLines.length, rightLines.length);
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const left = (leftLines[index] ?? '').padEnd(leftWidth).slice(0, leftWidth);
    const right = (rightLines[index] ?? '').slice(0, rightWidth);
    rows.push(`${left} | ${right}`);
  }
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/cli.test.mjs --test-name-pattern "tui model renders"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/tui.mjs test/cli.test.mjs
git commit -m "feat: add coven-code tui frame renderer"
```

## Task 4: Add Keyboard Handling and Command Palette Actions

**Files:**
- Modify: `src/cli/tui.mjs`
- Test: `test/cli.test.mjs`

- [ ] **Step 1: Write failing keyboard tests**

Append:

```js
test('tui key handling cycles tabs and command palette actions reuse interactive commands', async () => {
  const { createTuiModel, handleTuiKey } = await import(pathToFileURL(path.join(repoRoot, 'src', 'cli', 'tui.mjs')));
  const model = createTuiModel({ mode: 'smart', reasoningEffort: 'medium' });
  const session = {
    parsed: { mode: 'smart', reasoningEffort: 'medium' },
    queuedMessages: [],
    commandRunner: async () => {},
    executeRunner: async () => undefined,
    editorReader: async () => '',
  };

  await handleTuiKey(model, session, { name: 'tab' });
  assert.equal(model.activeTab, 'tools');

  await handleTuiKey(model, session, { ctrl: true, name: 'p' });
  assert.equal(model.paletteOpen, true);

  model.paletteIndex = 0;
  await handleTuiKey(model, session, { name: 'enter' });
  assert.equal(model.paletteOpen, false);
  assert.equal(model.transcript.at(-1).text, 'new thread');

  model.composer = '/mode deep';
  await handleTuiKey(model, session, { name: 'enter' });
  assert.equal(session.parsed.mode, 'deep');
  assert.match(model.transcript.at(-1).text, /mode: deep/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/cli.test.mjs --test-name-pattern "tui key handling"`

Expected: FAIL because `handleTuiKey` is not exported.

- [ ] **Step 3: Implement `handleTuiKey` and palette actions**

Add:

```js
const PALETTE_ACTIONS = [
  ['New thread', '/new'],
  ['Continue latest thread', '/continue'],
  ['Open help', '/help'],
  ['List tools', '/tools list'],
  ['List skills', '/skill: list'],
  ['List plugins', '/plugins: list'],
];

export async function handleTuiKey(model, session, key) {
  if (key?.name === 'tab') {
    const index = TABS.indexOf(model.activeTab);
    model.activeTab = TABS[(index + 1) % TABS.length];
    return;
  }
  if (key?.ctrl && key.name === 'p') {
    model.paletteOpen = true;
    model.paletteIndex = 0;
    return;
  }
  if (model.paletteOpen && key?.name === 'enter') {
    const [, command] = PALETTE_ACTIONS[model.paletteIndex ?? 0];
    model.paletteOpen = false;
    await submitTuiText(model, session, command);
    return;
  }
  if (key?.ctrl && key.name === 'n') {
    await submitTuiText(model, session, '/new');
    return;
  }
  if (key?.ctrl && key.name === 'r') {
    await submitTuiText(model, session, '/reasoning next');
    return;
  }
  if (key?.ctrl && key.name === 'm') {
    const next = session.parsed.mode === 'smart' ? 'deep' : session.parsed.mode === 'deep' ? 'rush' : 'smart';
    await submitTuiText(model, session, `/mode ${next}`);
    return;
  }
  if (key?.name === 'enter') {
    const text = model.composer.trim();
    model.composer = '';
    await submitTuiText(model, session, text);
  }
}

async function submitTuiText(model, session, text) {
  if (!text) return;
  model.transcript.push({ role: 'you', text });
  model.status = 'running';
  const result = await handleInteractiveInput(session, text);
  model.mode = session.parsed.mode;
  model.reasoningEffort = session.parsed.reasoningEffort ?? model.reasoningEffort;
  model.threadId = session.thread?.id ?? 'new thread';
  model.queueCount = session.queuedMessages.length;
  if (result.lines.length > 0) model.transcript.push({ role: result.kind === 'error' ? 'error' : 'coven', text: result.lines.join('\n') });
  model.status = result.kind === 'exit' ? 'done' : 'idle';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/cli.test.mjs --test-name-pattern "tui key handling"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/tui.mjs test/cli.test.mjs
git commit -m "feat: add coven-code tui keyboard actions"
```

## Task 5: Run the Full-Screen TUI Loop

**Files:**
- Modify: `src/cli/tui.mjs`
- Test: `test/cli.test.mjs`

- [ ] **Step 1: Write failing smoke test for scripted TUI input**

Append:

```js
test('tui scripted smoke processes input and exits without changing execute mode', async () => {
  const result = runCovenCode([], {
    input: '/mode deep\n/exit\n',
    env: {
      COVEN_CODE_TUI_SCRIPTED: '1',
      COVEN_CODE_REPL_HISTORY: '0',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Coven Code/);
  assert.match(result.stdout, /mode: deep/);

  const execute = runCovenCode(['-x', 'what is 2+2?']);
  assert.equal(execute.status, 0, execute.stderr);
  assert.equal(execute.stdout.trim(), '4');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/cli.test.mjs --test-name-pattern "tui scripted smoke"`

Expected: FAIL because scripted TUI mode is not implemented.

- [ ] **Step 3: Implement scripted and interactive TUI loops**

In `runTuiInteractive`:

- Create `session = createInteractiveSession(parsed)`.
- Create `model = createTuiModel(...)`.
- If `COVEN_CODE_TUI_SCRIPTED=1`, read newline-separated commands from `initialInput`, call `submitTuiText`, print `renderTuiFrame`, and return.
- For real TTY mode, use `readline.emitKeypressEvents(process.stdin)`, raw mode when available, clear/redraw the frame with ANSI `\x1b[2J\x1b[H`, and dispatch keys to `handleTuiKey`.
- On `Ctrl-C`, restore raw mode and exit.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/cli.test.mjs --test-name-pattern "tui scripted smoke"`

Expected: PASS.

- [ ] **Step 5: Manual smoke in Terminal**

Run in Terminal:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-code
COVEN_CODE_REPL_HISTORY=0 COVEN_CODE_SKIP_UPDATE_CHECK=1 npm run coven-code
```

Expected: full-screen TUI opens, shows header/tabs/transcript/status/composer, `/exit` leaves cleanly.

- [ ] **Step 6: Commit**

```bash
git add src/cli/tui.mjs test/cli.test.mjs
git commit -m "feat: run coven-code panel tui"
```

## Task 6: Update Docs and Final Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/CLI.md`
- Modify: `docs/DEVELOPMENT.md`

- [ ] **Step 1: Write docs updates**

Document:

- Bare `coven-code` opens the panel TUI.
- `COVEN_CODE_REPL=1 coven-code` opens the classic readline REPL.
- `COVEN_CODE_TUI_SCRIPTED=1` is only for tests/automation.
- `-x`, `--stream-json`, stdin piping, and subcommands are unchanged.

- [ ] **Step 2: Verify docs diff**

Run: `git diff -- README.md docs/CLI.md docs/DEVELOPMENT.md`

Expected: only TUI-related documentation changes.

- [ ] **Step 3: Run targeted checks**

Run:

```bash
git diff --check
node ./bin/coven-code.mjs --help
node ./bin/coven-code.mjs -x "what is 2+2?"
npm test
```

Expected:

- `git diff --check` exits 0
- help renders
- execute mode prints `4`
- tests pass with 0 failures

- [ ] **Step 4: Commit**

```bash
git add README.md docs/CLI.md docs/DEVELOPMENT.md
git commit -m "docs: document coven-code panel tui"
```

## Final Verification

Run:

```bash
git diff --check
node ./bin/coven-code.mjs --help
node ./bin/coven-code.mjs -x "what is 2+2?"
COVEN_CODE_TUI_SCRIPTED=1 COVEN_CODE_REPL_HISTORY=0 node ./bin/coven-code.mjs <<'EOF'
/mode deep
/exit
EOF
npm test
git status --short --branch
```

Expected:

- whitespace check passes
- help renders
- execute mode prints `4`
- scripted TUI output includes `Coven Code` and `mode: deep`
- tests pass with 0 failures
- worktree is clean except being ahead by local commits
