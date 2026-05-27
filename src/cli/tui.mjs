import { runInteractive } from './repl.mjs';
import { CLI_NAME, VERSION } from '../constants.mjs';
import { createInteractiveSession, handleInteractiveInput, slashHelpLines } from './interactive-core.mjs';
import { splitShellWords } from '../util/shell.mjs';
import {
  defaultLaneState,
  inspectLane,
  nextLaneHarness,
  normalizeLaneHarness,
  runLaneVerification,
} from '../agent/lane.mjs';

const TABS = ['chat', 'lane', 'tools', 'threads', 'config', 'help'];
const PALETTE_ACTIONS = [
  ['New thread', '/new'],
  ['Continue latest thread', '/continue'],
  ['Refresh lane', '/lane refresh'],
  ['Cycle harness', '/lane harness next'],
  ['Run verification', '/lane verify'],
  ['Open help', '/help'],
  ['List tools', '/tools list'],
  ['List skills', '/skill: list'],
  ['List plugins', '/plugins: list'],
];

export async function runTuiInteractive(parsed, initialInput = '') {
  const session = createInteractiveSession(parsed);
  const model = createTuiModel({
    mode: parsed.mode,
    reasoningEffort: parsed.reasoningEffort,
  });
  if (process.env.COVEN_CODE_TUI_SCRIPTED === '1') {
    for (const line of initialInput.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      await submitTuiText(model, session, text);
      if (model.status === 'done') break;
    }
    console.log(renderTuiFrame(model, { columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }));
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) return runInteractive(parsed, initialInput);
  return runLiveTui(model, session);
}

export function createTuiModel(options = {}) {
  return {
    version: options.version ?? VERSION,
    mode: options.mode ?? 'smart',
    reasoningEffort: options.reasoningEffort ?? 'high',
    threadId: options.threadId ?? 'new thread',
    toolCount: options.toolCount ?? 0,
    queueCount: options.queueCount ?? 0,
    activeTab: options.activeTab ?? 'chat',
    paletteOpen: false,
    paletteIndex: 0,
    composer: '',
    transcript: [],
    lane: defaultLaneState({ harness: options.mode ?? 'smart', ...options.lane }),
    status: 'idle',
  };
}

export function renderTuiFrame(model, size = {}) {
  const columns = Math.max(50, size.columns ?? process.stdout.columns ?? 80);
  const rows = Math.max(16, size.rows ?? process.stdout.rows ?? 24);
  const divider = '-'.repeat(columns);
  const tabs = TABS.join(' ');
  const bodyRows = Math.max(3, rows - 7);
  const transcript = renderTranscript(model, Math.max(3, bodyRows - 1), columns - 25);
  const status = [
    `thread: ${model.threadId}`,
    `lane: ${model.lane.branch}`,
    `harness: ${model.lane.harness}`,
    `mode: ${model.mode}`,
    `reasoning: ${model.reasoningEffort}`,
    `queued: ${model.queueCount}`,
    `tools: ${model.toolCount}`,
    `active: ${model.activeTab}`,
    `status: ${model.status}`,
  ];
  const lines = [
    `Coven Code ${model.version}`.slice(0, columns),
    tabs.slice(0, columns),
    divider,
    ...mergeColumns(transcript, status, columns),
    divider,
    `> ${model.composer}`.slice(0, columns),
  ];
  return lines.slice(0, rows).join('\n');
}

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
    const [, command] = PALETTE_ACTIONS[model.paletteIndex ?? 0] ?? PALETTE_ACTIONS[0];
    model.paletteOpen = false;
    await submitTuiText(model, session, command);
    return;
  }
  if (model.paletteOpen && key?.name === 'down') {
    model.paletteIndex = (model.paletteIndex + 1) % PALETTE_ACTIONS.length;
    return;
  }
  if (model.paletteOpen && key?.name === 'up') {
    model.paletteIndex = (model.paletteIndex + PALETTE_ACTIONS.length - 1) % PALETTE_ACTIONS.length;
    return;
  }
  if (model.paletteOpen && key?.name === 'escape') {
    model.paletteOpen = false;
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

function renderTranscript(model, limit, width) {
  if (model.activeTab === 'help') return slashHelpLines().slice(0, limit).map((line) => line.slice(0, width));
  if (model.activeTab === 'lane') return renderLaneLines(model, limit, width);
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

async function submitTuiText(model, session, text) {
  if (!text) return;
  model.transcript.push({ role: 'you', text });
  model.status = 'running';
  const { result, stdout, stderr } = isLaneCommand(text)
    ? await handleTuiLaneCommand(model, session, text)
    : await captureTerminalOutput(() => handleInteractiveInput(session, text));
  model.mode = session.parsed.mode;
  model.reasoningEffort = session.parsed.reasoningEffort ?? model.reasoningEffort;
  model.threadId = session.thread?.id ?? 'new thread';
  model.queueCount = session.queuedMessages.length;
  rememberLaneTerminal(model, stdout, stderr, result.lines);
  if (stderr.trim()) {
    model.transcript.push({ role: 'error', text: stderr.trim() });
  }
  if (stdout.trim()) {
    model.transcript.push({ role: 'coven', text: stdout.trim() });
  }
  if (result.lines.length > 0) {
    model.transcript.push({
      role: result.kind === 'error' ? 'error' : 'coven',
      text: result.lines.join('\n'),
    });
  }
  model.status = result.kind === 'exit' ? 'done' : 'idle';
}

async function runLiveTui(model, session) {
  try {
    const blessedModule = await import('neo-blessed');
    return runBlessedTui(blessedModule.default ?? blessedModule, model, session);
  } catch (error) {
    console.error(`${CLI_NAME}: unable to start panel TUI, falling back to classic REPL: ${error?.message ?? error}`);
    return runInteractive(session.parsed, '');
  }
}

function runBlessedTui(blessed, model, session) {
  return new Promise((resolve) => {
    const screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      title: `${CLI_NAME} ${model.version}`,
    });
    const header = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 3,
      padding: { left: 1, right: 1 },
      style: { fg: 'white', bg: 'black' },
    });
    const transcript = blessed.box({
      top: 3,
      left: 0,
      width: '70%',
      bottom: 3,
      label: ' Chat ',
      border: 'line',
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      padding: { left: 1, right: 1 },
      scrollbar: { ch: ' ', style: { bg: 'white' } },
      style: {
        border: { fg: 'cyan' },
      },
    });
    const status = blessed.box({
      top: 3,
      right: 0,
      width: '30%',
      bottom: 3,
      label: ' Status ',
      border: 'line',
      padding: { left: 1, right: 1 },
      style: {
        border: { fg: 'magenta' },
      },
    });
    const composer = blessed.box({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      label: ' Prompt ',
      border: 'line',
      padding: { left: 1, right: 1 },
      style: {
        border: { fg: 'green' },
      },
    });
    const palette = blessed.list({
      top: 'center',
      left: 'center',
      width: '60%',
      height: Math.min(12, PALETTE_ACTIONS.length + 2),
      label: ' Command Palette ',
      border: 'line',
      hidden: true,
      keys: true,
      mouse: true,
      items: PALETTE_ACTIONS.map(([label, command]) => `${label}  ${command}`),
      style: {
        border: { fg: 'yellow' },
        selected: { bg: 'blue', fg: 'white' },
      },
    });

    screen.append(header);
    screen.append(transcript);
    screen.append(status);
    screen.append(composer);
    screen.append(palette);
    screen.program.hideCursor();

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      screen.program.showCursor();
      screen.destroy();
      resolve();
    };
    const sync = () => {
      header.setContent(`${CLI_NAME} ${model.version}\n${renderTabLine(model)}`);
      transcript.setContent(renderTranscriptText(model));
      status.setContent(renderStatusText(model));
      composer.setContent(`> ${model.composer}`);
      if (model.paletteOpen) {
        palette.show();
        palette.select(model.paletteIndex);
        palette.focus();
      } else {
        palette.hide();
      }
      screen.render();
    };
    const dispatchKey = async (key) => {
      await handleTuiKey(model, session, normalizeBlessedKey(key));
      sync();
      if (model.status === 'done') cleanup();
    };

    screen.on('keypress', async (chunk, key = {}) => {
      if (settled) return;
      if (key.ctrl && key.name === 'c') {
        cleanup();
        return;
      }
      if (key.name === 'backspace' || key.name === 'delete') {
        model.composer = model.composer.slice(0, -1);
        sync();
        return;
      }
      if (isPrintableChunk(chunk, key)) {
        model.composer += chunk;
        sync();
        return;
      }
      await dispatchKey(key);
    });

    sync();
  });
}

function renderTabLine(model) {
  return TABS.map((tab) => tab === model.activeTab ? `[${tab}]` : ` ${tab} `).join(' ');
}

function renderTranscriptText(model) {
  if (model.activeTab === 'help') return slashHelpLines().join('\n');
  if (model.activeTab === 'lane') return renderLaneLines(model, 1000, 1000).join('\n');
  if (model.activeTab !== 'chat') return `${model.activeTab} panel\nUse slash commands or Ctrl-P palette actions.`;
  if (model.transcript.length === 0) return 'Ready. Type a prompt or /help.';
  return model.transcript
    .map((entry) => `${entry.role}:\n${entry.text}`)
    .join('\n\n');
}

function renderStatusText(model) {
  return [
    `thread: ${model.threadId}`,
    `lane: ${model.lane.branch}`,
    `harness: ${model.lane.harness}`,
    `mode: ${model.mode}`,
    `reasoning: ${model.reasoningEffort}`,
    `queued: ${model.queueCount}`,
    `tools: ${model.toolCount}`,
    `active: ${model.activeTab}`,
    `status: ${model.status}`,
    '',
    'Keys',
    'Tab: next panel',
    'Ctrl-P: palette',
    'Ctrl-N: new thread',
    'Ctrl-R: reasoning',
    'Ctrl-M: mode',
    '/lane refresh',
    '/lane verify',
    'Ctrl-C: quit',
  ].join('\n');
}

function renderLaneLines(model, limit, width) {
  const lane = model.lane;
  const changedFiles = lane.changedFiles.length > 0 ? lane.changedFiles : ['none'];
  const lines = [
    `worktree: ${lane.worktree}`,
    `branch: ${lane.branch}`,
    `base: ${lane.baseBranch}`,
    `harness: ${lane.harness}`,
    `status: ${lane.status}`,
    `verify: ${lane.verification.status} (${lane.verification.command})`,
    `PR: ${lane.pullRequest}`,
    `merge: ${lane.merge}`,
    `cleanup: ${lane.cleanup}`,
    '',
    'Changed files',
    ...changedFiles.map((file) => `  ${file}`),
    '',
    'Diff',
    lane.diffSummary || '  no diff summary',
    '',
    'Terminal',
    ...(lane.terminalLines.length > 0 ? lane.terminalLines : ['  no lane terminal output yet']),
  ];
  return lines.slice(0, limit).map((line) => line.slice(0, width));
}

function isLaneCommand(text) {
  return /^\/lane(?:\s|$)/.test(text);
}

async function handleTuiLaneCommand(model, session, text) {
  try {
    const [, subcommand = 'status', ...rest] = splitShellWords(text.slice(1));
    if (subcommand === 'refresh') {
      const inspector = session.laneInspector ?? inspectLane;
      model.lane = await inspector({
        cwd: process.cwd(),
        harness: model.lane.harness,
        verification: model.lane.verification,
      });
      model.activeTab = 'lane';
      return laneCommandResult(`lane refreshed: ${model.lane.branch}`);
    }
    if (subcommand === 'harness') {
      const requested = rest[0] === 'next' ? nextLaneHarness(model.lane.harness) : rest[0];
      const harness = normalizeLaneHarness(requested);
      model.lane = { ...model.lane, harness };
      model.activeTab = 'lane';
      return laneCommandResult(`harness: ${harness}`);
    }
    if (subcommand === 'verify') {
      const verifier = session.laneVerifier ?? runLaneVerification;
      model.lane = await verifier(model.lane);
      model.activeTab = 'lane';
      return laneCommandResult(`verification: ${model.lane.verification.status}`);
    }
    if (subcommand === 'diff') {
      model.activeTab = 'lane';
      return laneCommandResult(model.lane.diffSummary || 'no diff summary');
    }
    if (subcommand === 'status') {
      model.activeTab = 'lane';
      return laneCommandResult(renderLaneLines(model, 40, 120).join('\n'));
    }
    return laneCommandResult(`${CLI_NAME}: Unknown lane command: ${subcommand}`, 'error');
  } catch (error) {
    return laneCommandResult(`${CLI_NAME}: ${error?.message ?? error}`, 'error');
  }
}

function laneCommandResult(text, kind = 'command') {
  return {
    result: { kind, lines: [text] },
    stdout: '',
    stderr: '',
  };
}

function rememberLaneTerminal(model, stdout, stderr, resultLines = []) {
  const lines = [stdout, stderr, resultLines.join('\n')]
    .flatMap((text) => String(text ?? '').split(/\r?\n/))
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (lines.length === 0) return;
  model.lane = {
    ...model.lane,
    terminalLines: [...(model.lane.terminalLines ?? []), ...lines].slice(-40),
  };
}

function normalizeBlessedKey(key = {}) {
  if (key.name === 'return') return { ...key, name: 'enter' };
  return key;
}

function isPrintableChunk(chunk, key = {}) {
  return typeof chunk === 'string'
    && chunk.length > 0
    && !key.ctrl
    && !key.meta
    && key.name !== 'return'
    && key.name !== 'enter'
    && key.name !== 'tab'
    && key.name !== 'escape'
    && key.name !== 'up'
    && key.name !== 'down'
    && key.name !== 'left'
    && key.name !== 'right';
}

async function captureTerminalOutput(fn) {
  let stdout = '';
  let stderr = '';
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = function tuiStdoutWrite(chunk, encoding, callback) {
    stdout += normalizeWriteChunk(chunk, encoding);
    callWriteCallback(encoding, callback);
    return true;
  };
  process.stderr.write = function tuiStderrWrite(chunk, encoding, callback) {
    stderr += normalizeWriteChunk(chunk, encoding);
    callWriteCallback(encoding, callback);
    return true;
  };
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

function normalizeWriteChunk(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk.toString(typeof encoding === 'string' ? encoding : 'utf8');
  return String(chunk);
}

function callWriteCallback(encoding, callback) {
  if (typeof encoding === 'function') encoding();
  else if (typeof callback === 'function') callback();
}
