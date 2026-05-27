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

test('interactive core handles mode, reasoning, queue, and new thread slash commands', async () => {
  const { createInteractiveSession, handleInteractiveInput } = await import(pathToFileURL(path.join(repoRoot, 'src', 'cli', 'interactive-core.mjs')));
  const parsed = { mode: 'smart', reasoningEffort: undefined };
  const session = createInteractiveSession(parsed);

  const mode = await handleInteractiveInput(session, '/mode deep');
  assert.equal(mode.kind, 'command');
  assert.deepEqual(mode.lines, ['mode: deep', 'reasoning effort: high']);
  assert.equal(parsed.mode, 'deep');
  assert.equal(parsed.reasoningEffort, 'high');

  const reasoning = await handleInteractiveInput(session, '/reasoning next');
  assert.equal(reasoning.kind, 'command');
  assert.deepEqual(reasoning.lines, ['reasoning effort: low']);
  assert.equal(parsed.reasoningEffort, 'low');

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

test('tui model renders panel layout with transcript tabs status rail and composer', async () => {
  const { createTuiModel, renderTuiFrame } = await import(pathToFileURL(path.join(repoRoot, 'src', 'cli', 'tui.mjs')));

  const model = createTuiModel({
    version: '0.0.0-test',
    mode: 'smart',
    reasoningEffort: 'medium',
    threadId: 'T-test',
    toolCount: 18,
  });
  model.transcript.push({ role: 'you', text: 'hello' });
  model.composer = 'what is 2+2?';

  const frame = renderTuiFrame(model, { columns: 82, rows: 24, color: false });

  assert.match(frame, /Coven Code 0\.0\.0-test/);
  assert.match(frame, /\[chat\]\s+lane\s+tools\s+threads\s+config\s+help/);
  assert.match(frame, /you/);
  assert.match(frame, /hello/);
  assert.match(frame, /thread: T-test/);
  assert.match(frame, /mode: smart/);
  assert.match(frame, /> what is 2\+2\?/);
});

test('tui lane panel renders worktree branch harness git diff verification and cleanup state', async () => {
  const { createTuiModel, renderTuiFrame } = await import(pathToFileURL(path.join(repoRoot, 'src', 'cli', 'tui.mjs')));

  const model = createTuiModel({
    activeTab: 'lane',
    lane: {
      worktree: '/tmp/cast-codes-lane',
      branch: 'meow/lane-parity',
      baseBranch: 'main',
      harness: 'deep',
      status: 'ready',
      changedFiles: ['app/src/lane.rs', 'app/src/workspace.rs'],
      diffSummary: '2 files changed, 18 insertions(+)',
      verification: {
        command: 'cargo check -p warp-app --bin cast-codes --features gui',
        status: 'passed',
      },
      terminalLines: ['cargo check finished'],
      pullRequest: 'not opened',
      merge: 'not merged',
      cleanup: 'pending',
    },
  });

  const frame = renderTuiFrame(model, { columns: 120, rows: 30 });

  assert.match(frame, /chat\s+\[lane\]\s+tools\s+threads\s+config\s+help/);
  assert.match(frame, /worktree: \/tmp\/cast-codes-lane/);
  assert.match(frame, /branch: meow\/lane-parity/);
  assert.match(frame, /base: main/);
  assert.match(frame, /harness: deep/);
  assert.match(frame, /app\/src\/lane\.rs/);
  assert.match(frame, /2 files changed, 18 insertions/);
  assert.match(frame, /verify: passed/);
  assert.match(frame, /PR: not opened/);
  assert.match(frame, /merge: not merged/);
  assert.match(frame, /cleanup: pending/);
});

test('tui lane commands refresh git state and cycle harness without leaving the panel', async () => {
  const { createTuiModel, handleTuiKey } = await import(pathToFileURL(path.join(repoRoot, 'src', 'cli', 'tui.mjs')));
  const model = createTuiModel({ activeTab: 'lane', mode: 'smart', reasoningEffort: 'medium' });
  const session = {
    parsed: { mode: 'smart', reasoningEffort: 'medium' },
    queuedMessages: [],
    commandRunner: async () => {},
    executeRunner: async () => undefined,
    editorReader: async () => '',
    laneInspector: async () => ({
      worktree: '/tmp/cast-codes-lane',
      branch: 'meow/lane-parity',
      baseBranch: 'main',
      harness: 'smart',
      status: 'dirty',
      changedFiles: ['README.md'],
      diffSummary: '1 file changed, 2 insertions(+)',
      verification: { command: 'npm test', status: 'not run' },
      terminalLines: ['git status --short', ' M README.md'],
      pullRequest: 'not opened',
      merge: 'not merged',
      cleanup: 'pending',
    }),
  };

  model.composer = '/lane refresh';
  await handleTuiKey(model, session, { name: 'enter' });

  assert.equal(model.activeTab, 'lane');
  assert.equal(model.lane.branch, 'meow/lane-parity');
  assert.deepEqual(model.lane.changedFiles, ['README.md']);
  assert.match(model.transcript.at(-1).text, /lane refreshed: meow\/lane-parity/);

  model.composer = '/lane harness deep';
  await handleTuiKey(model, session, { name: 'enter' });

  assert.equal(model.lane.harness, 'deep');
  assert.match(model.transcript.at(-1).text, /harness: deep/);
});

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
  assert.equal(model.activeTab, 'lane');

  await handleTuiKey(model, session, { ctrl: true, name: 'p' });
  assert.equal(model.paletteOpen, true);

  await handleTuiKey(model, session, { name: 'down' });
  assert.equal(model.paletteIndex, 1);

  await handleTuiKey(model, session, { name: 'up' });
  assert.equal(model.paletteIndex, 0);

  await handleTuiKey(model, session, { name: 'enter' });
  assert.equal(model.paletteOpen, false);
  assert.equal(model.transcript.at(-1).text, 'new thread');

  model.composer = '/mode deep';
  await handleTuiKey(model, session, { name: 'enter' });
  assert.equal(session.parsed.mode, 'deep');
  assert.match(model.transcript.at(-1).text, /mode: deep/);
});

test('tui agent turn pulls the assistant reply from the thread and ignores stray stdout writes', async () => {
  const { createTuiModel, handleTuiKey } = await import(pathToFileURL(path.join(repoRoot, 'src', 'cli', 'tui.mjs')));
  const model = createTuiModel({ mode: 'smart', reasoningEffort: 'medium' });
  const session = {
    parsed: { mode: 'smart', reasoningEffort: 'medium' },
    queuedMessages: [],
    silent: true,
    commandRunner: async () => {},
    executeRunner: async () => {
      process.stdout.write('\x1B7\x1B[26;1Hyou:hello\x1B[58;1Hrunning\x1B8');
      await Promise.resolve();
      return {
        id: 'T-test',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi from the agent' },
        ],
      };
    },
    editorReader: async () => '',
  };

  model.composer = 'hello';
  model.composerCursor = 'hello'.length;
  await handleTuiKey(model, session, { name: 'enter' });

  const covenEntries = model.transcript.filter((entry) => entry.role === 'coven');
  assert.equal(covenEntries.length, 1, 'expected exactly one assistant transcript entry');
  assert.equal(covenEntries[0].text, 'hi from the agent');
  assert.ok(
    !model.transcript.some((entry) => /\x1B|\[26;1H|\[58;1H/.test(entry.text)),
    'transcript must not contain raw blessed render bytes',
  );
});

test('tui scripted smoke processes input and exits without changing execute mode', () => {
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

test('tui scripted prompt renders assistant output inside the transcript', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-tui-home-'));
  const result = runCovenCode([], {
    input: 'what is 2+2?\n/exit\n',
    env: {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      COVEN_CODE_TUI_SCRIPTED: '1',
      COVEN_CODE_REPL_HISTORY: '0',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Coven Code/);
  assert.match(result.stdout, /you:/);
  assert.match(result.stdout, /what is 2\+2\?/);
  assert.match(result.stdout, /coven:/);
  assert.match(result.stdout, /\b4\b/);
  assert.doesNotMatch(result.stdout.trimStart(), /^Coven Code local runtime received:/);
});

test(
  'interactive REPL runs a turn, handles /help, and exits cleanly on /exit',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  () => {
    const script = [
      'log_user 1',
      'set timeout 10',
      'set env(HIDDEN_SHELL_OUTPUT) "hidden-live-shell"',
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
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
  'interactive REPL command palette help alias shows slash commands',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  () => {
    const script = [
      'log_user 1',
      'set timeout 10',
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "/coven-code: help\\r"',
      'expect {',
      '  -re "Slash commands:" { }',
      '  timeout { puts "TIMEOUT after command-palette help"; exit 2 }',
      '}',
      'expect {',
      '  -re {/mode \\[name\\] +show or set mode: smart, deep, rush, large} { puts "MATCHED_MODE_HELP" }',
      '  timeout { puts "TIMEOUT waiting for mode help line"; exit 7 }',
      '}',
      'expect {',
      '  -re {/editor +compose the next prompt in \\$EDITOR} { }',
      '  timeout { puts "TIMEOUT waiting for editor help line"; exit 3 }',
      '}',
      'expect {',
      '  -re "Keybindings:" { puts "MATCHED_KEYBINDINGS" }',
      '  timeout { puts "TIMEOUT waiting for keybindings help heading"; exit 4 }',
      '}',
      'expect {',
      '  -re {Ctrl\\+G +open the current prompt in \\$EDITOR} { puts "MATCHED_PROMPT_EDITOR_KEYBINDING" }',
      '  timeout { puts "TIMEOUT waiting for prompt editor keybinding"; exit 5 }',
      '}',
      'expect {',
      '  -re {Alt\\+D +cycle reasoning effort for the active mode} { puts "MATCHED_REASONING_KEYBINDING" }',
      '  timeout { puts "TIMEOUT waiting for reasoning keybinding"; exit 6 }',
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
    assert.match(result.stdout, /Slash commands:/);
    assert.match(result.stdout, /MATCHED_MODE_HELP/);
    assert.match(result.stdout, /MATCHED_KEYBINDINGS/);
    assert.match(result.stdout, /MATCHED_PROMPT_EDITOR_KEYBINDING/);
    assert.match(result.stdout, /MATCHED_REASONING_KEYBINDING/);
  },
);

test(
  'interactive REPL command palette ide connect reports IDE status',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  () => {
    const script = [
      'log_user 1',
      'set timeout 10',
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "/ide connect\\r"',
      'expect {',
      '  -re "ide: auto" { }',
      '  timeout { puts "TIMEOUT waiting for ide connect status"; exit 2 }',
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
    assert.match(result.stdout, /ide: auto/);
    assert.match(result.stdout, /status: unavailable \(local recreation\)/);
  },
);

test(
  'interactive REPL command palette skill-list alias lists skills',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "/skill: list\\r"',
      'expect {',
      '  -re "building-skills +built-in" { }',
      '  timeout { puts "TIMEOUT waiting for skill list"; exit 2 }',
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
    assert.match(result.stdout, /building-skills\s+built-in/);
  },
);

test(
  'interactive REPL command palette plugins-reload alias reloads plugins',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "/plugins: reload\\r"',
      'expect {',
      '  -re "Reloaded 0 plugin" { }',
      '  timeout { puts "TIMEOUT waiting for plugins reload"; exit 2 }',
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
    assert.match(result.stdout, /Reloaded 0 plugin\(s\)\./);
  },
);

test(
  'interactive REPL keeps thread context across turns',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
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
  'interactive REPL /new starts a fresh thread and /continue resumes an existing thread',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "the migration codename is quartz-river\\r"',
      'expect -re "> "',
      'send -- "/threads list\\r"',
      'expect {',
      '  -re "(T-\\[A-Za-z0-9-\\]+) +active" { set first_thread $expect_out(1,string) }',
      '  timeout { puts "TIMEOUT waiting for first thread id"; exit 2 }',
      '}',
      'expect -re "> "',
      'send -- "/new\\r"',
      'expect {',
      '  -re "new thread.*\\r?\\n.*> " { }',
      '  timeout { puts "TIMEOUT waiting for new thread acknowledgement"; exit 3 }',
      '}',
      'send -- "what codename was mentioned earlier?\\r"',
      'expect {',
      '  -re "\\nNo codename was found\\.\\r?\\n" { }',
      '  timeout { puts "TIMEOUT waiting for empty new-thread context"; exit 4 }',
      '}',
      'expect -re "> "',
      'send -- "/continue $first_thread\\r"',
      'expect {',
      '  -re "continued: $first_thread.*\\r?\\n.*> " { }',
      '  timeout { puts "TIMEOUT waiting for continue acknowledgement"; exit 5 }',
      '}',
      'send -- "what codename was mentioned earlier?\\r"',
      'expect {',
      '  -re "\\nquartz-river\\r?\\n" { }',
      '  timeout { puts "TIMEOUT waiting for resumed thread context"; exit 6 }',
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
    assert.match(result.stdout, /new thread/);
    assert.match(result.stdout, /continued: T-/);
    assert.match(result.stdout, /quartz-river/);
  },
);

test(
  'interactive REPL command palette archive-and-quit archives the current thread',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "the archive target is current-thread\\r"',
      'expect {',
      '  -re "> " { }',
      '  timeout { puts "TIMEOUT waiting for initial turn"; exit 2 }',
      '}',
      'send -- "/thread: archive and quit\\r"',
      'expect {',
      '  -re "Archived thread (T-\\[A-Za-z0-9-\\]+)" { set archived_thread $expect_out(1,string) }',
      '  timeout { puts "TIMEOUT waiting for archive acknowledgement"; exit 3 }',
      '}',
      'expect eof',
    ].join('\n');

    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(
      result.status,
      0,
      `expect exit ${result.status} signal ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /Archived thread T-/);

    const threadDir = path.join(xdg, 'coven-code', 'threads');
    const [threadFile] = await readdir(threadDir);
    const thread = JSON.parse(await readFile(path.join(threadDir, threadFile), 'utf8'));
    assert.equal(thread.archived, true);
  },
);

test(
  'interactive REPL command palette set-visibility updates the current thread',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "the visibility target is current-thread\\r"',
      'expect {',
      '  -re "> " { }',
      '  timeout { puts "TIMEOUT waiting for initial turn"; exit 2 }',
      '}',
      'send -- "/thread: set visibility public\\r"',
      'expect {',
      '  -re "Set (T-\\[A-Za-z0-9-\\]+) visibility to public" { set visible_thread $expect_out(1,string) }',
      '  timeout { puts "TIMEOUT waiting for visibility acknowledgement"; exit 3 }',
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
    assert.match(result.stdout, /Set T-[A-Za-z0-9-]+ visibility to public/);

    const threadDir = path.join(xdg, 'coven-code', 'threads');
    const [threadFile] = await readdir(threadDir);
    const thread = JSON.parse(await readFile(path.join(threadDir, threadFile), 'utf8'));
    assert.equal(thread.visibility, 'public');
  },
);

test(
  'interactive REPL command palette feedback report emits diagnostics for the current thread',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "the feedback target is current-thread\\r"',
      'expect {',
      '  -re "> " { }',
      '  timeout { puts "TIMEOUT waiting for initial turn"; exit 2 }',
      '}',
      'send -- "/feedback: send report with diagnostics\\r"',
      'expect {',
      '  -re "diagnostic_report_id: R-\\[A-Za-z0-9-\\]+" { }',
      '  timeout { puts "TIMEOUT waiting for diagnostic report"; exit 3 }',
      '}',
      'expect {',
      '  -re "thread_id: (T-\\[A-Za-z0-9-\\]+)" { set report_thread $expect_out(1,string) }',
      '  timeout { puts "TIMEOUT waiting for diagnostic thread id"; exit 4 }',
      '}',
      'expect -re "retention: 7 days"',
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
    assert.match(result.stdout, /diagnostic_report_id: R-/);
    assert.match(result.stdout, /thread_id: T-/);
    assert.match(result.stdout, /retention: 7 days/);
  },
);

test(
  'interactive REPL /mode changes the mode for later turns',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
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
    const threadDir = path.join(xdg, 'coven-code', 'threads');
    const [threadFile] = await readdir(threadDir);
    const thread = JSON.parse(await readFile(path.join(threadDir, threadFile), 'utf8'));
    assert.equal(thread.mode, 'rush');
  },
);

test(
  'interactive REPL /reasoning shows and changes reasoning effort',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "/reasoning xhigh\\r"',
      'expect {',
      '  -re "reasoning effort: xhigh.*\\r?\\n.*> " { }',
      '  timeout { puts "TIMEOUT waiting for reasoning switch"; exit 5 }',
      '}',
      'send -- "/reasoning\\r"',
      'expect {',
      '  -re "reasoning effort: xhigh.*\\r?\\n.*> " { }',
      '  timeout { puts "TIMEOUT waiting for reasoning status"; exit 6 }',
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
    assert.match(result.stdout, /reasoning effort: xhigh/);
  },
);

test(
  'interactive REPL editor command opens EDITOR and submits the edited prompt',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const editorScript = path.join(home, 'editor.mjs');
    await writeFile(editorScript, `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], 'what is 2+2?\\n');
`);
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `set env(EDITOR) "${process.execPath} ${editorScript}"`,
      `cd "${cwd}"`,
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "/editor\\r"',
      'expect {',
      '  -re "\\n4\\r?\\n" { }',
      '  timeout { puts "TIMEOUT waiting for editor prompt result"; exit 2 }',
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

    const threadDir = path.join(xdg, 'coven-code', 'threads');
    const [threadFile] = await readdir(threadDir);
    const thread = JSON.parse(await readFile(path.join(threadDir, threadFile), 'utf8'));
    assert.equal(thread.messages.at(0).content, 'what is 2+2?');
  },
);

test(
  'interactive REPL edit command replaces the previous user turn',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const editorScript = path.join(home, 'editor.mjs');
    const seedFile = path.join(home, 'edit-seed.txt');
    await writeFile(editorScript, `import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(seedFile)}, readFileSync(process.argv[2], 'utf8'));
writeFileSync(process.argv[2], 'the migration codename is amber-lake\\n');
`);
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `set env(EDITOR) "${process.execPath} ${editorScript}"`,
      `cd "${cwd}"`,
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "the migration codename is quartz-river\\r"',
      'expect -re "> "',
      'send -- "/edit\\r"',
      'expect {',
      '  -re "> " { }',
      '  timeout { puts "TIMEOUT waiting for edited turn"; exit 2 }',
      '}',
      'send -- "what codename was mentioned earlier?\\r"',
      'expect {',
      '  -re "\\namber-lake\\r?\\n" { }',
      '  timeout { puts "TIMEOUT waiting for edited codename"; exit 3 }',
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
    assert.match(result.stdout, /amber-lake/);
    assert.equal(await readFile(seedFile, 'utf8'), 'the migration codename is quartz-river');

    const threadDir = path.join(xdg, 'coven-code', 'threads');
    const [threadFile] = await readdir(threadDir);
    const thread = JSON.parse(await readFile(path.join(threadDir, threadFile), 'utf8'));
    assert.equal(thread.messages[0].content, 'the migration codename is amber-lake');
    assert.equal(thread.messages.filter((message) => message.content === 'the migration codename is quartz-river').length, 0);
  },
);

test(
  'interactive REPL /queue runs a follow-up prompt after the next turn',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const xdg = path.join(home, '.config');
    const cwd = await makeWorkspace();
    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(HOME) "${home}"`,
      `set env(XDG_CONFIG_HOME) "${xdg}"`,
      `cd "${cwd}"`,
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
      'expect -re "interactive mode"',
      'expect -re "> "',
      'send -- "/queue now add 8 to that\\r"',
      'expect {',
      '  -re "queued: now add 8 to that.*\\r?\\n.*> " { }',
      '  timeout { puts "TIMEOUT waiting for queued acknowledgement"; exit 2 }',
      '}',
      'send -- "what is 2+2?\\r"',
      'expect {',
      '  -re "\\n4\\r?\\n" { }',
      '  timeout { puts "TIMEOUT waiting for queued follow-up result"; exit 3 }',
      '}',
      'expect -re "\\n12\\r?\\n"',
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
    assert.match(result.stdout, /\n12\r?\n/);
  },
);

test(
  'interactive REPL passes /<subcommand> through to the top-level dispatcher',
  { skip: expectAvailable ? false : 'expect(1) not installed' },
  () => {
    const script = [
      'log_user 1',
      'set timeout 10',
      'set env(HIDDEN_SHELL_OUTPUT) "hidden-live-shell"',
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
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
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
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
    const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
    const historyPath = path.join(home, 'repl_history');
    await writeFile(historyPath, 'what is 2+2?\n');

    const script = [
      'log_user 1',
      'set timeout 10',
      `set env(COVEN_CODE_REPL_HISTORY_FILE) "${historyPath}"`,
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
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
      `spawn -noecho env COVEN_CODE_REPL=1 ${process.execPath} ${covenCodeBin}`,
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

test('interactive stdin no longer executes manual shell-mode prompts', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const marker = path.join(home, 'shell-mode-marker.txt');
  const command = `$ ${process.execPath} -e "require('node:fs').writeFileSync(process.env.MARKER, 'ran')"\n`;

  const result = runCovenCode([], {
    input: command,
    env: { MARKER: marker },
  });

  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });
});
