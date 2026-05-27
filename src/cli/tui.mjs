import { existsSync } from 'node:fs';
import { runInteractive } from './repl.mjs';
import { CLI_NAME, VERSION } from '../constants.mjs';
import { createInteractiveSession, handleInteractiveInput } from './interactive-core.mjs';
import { splitShellWords } from '../util/shell.mjs';
import {
  defaultLaneState,
  inspectLane,
  nextLaneHarness,
  normalizeLaneHarness,
  runLaneVerification,
} from '../agent/lane.mjs';
import { displayCwd } from '../util/fs.mjs';
import { findWorkspaceSettingsFile, settingsFile } from '../settings/paths.mjs';
import { readEffectiveSettings } from '../settings/load.mjs';
import { listThreads } from '../threads/store.mjs';
import {
  buildSlashCommandCatalog,
  buildStaticSlashCommandCatalog,
  builtinToolSummaryLines,
  filterSlashCommands,
  formatSlashCommandDetails,
  formatSlashHelpLines,
} from './slash-commands.mjs';

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
  ['Open editor', '/editor'],
  ['Edit previous prompt', '/edit'],
  ['Archive and quit', '/thread: archive and quit'],
];

export async function runTuiInteractive(parsed, initialInput = '') {
  const session = createInteractiveSession(parsed);
  const slashCatalog = await safeBuildSlashCommandCatalog(parsed);
  const model = createTuiModel({
    mode: parsed.mode,
    reasoningEffort: parsed.reasoningEffort,
    slashCatalog,
    parsed,
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
  const slashCatalog = options.slashCatalog ?? buildStaticSlashCommandCatalog();
  const composer = options.composer ?? '';
  const workspaceCwd = options.cwd ?? process.cwd();
  const model = {
    version: options.version ?? VERSION,
    cwd: displayCwd(workspaceCwd),
    workspaceCwd,
    mode: options.mode ?? 'smart',
    reasoningEffort: options.reasoningEffort ?? 'high',
    threadId: options.threadId ?? 'new thread',
    toolCount: options.toolCount ?? 0,
    queueCount: options.queueCount ?? 0,
    activeTab: options.activeTab ?? 'chat',
    paletteOpen: false,
    paletteIndex: 0,
    composer,
    composerCursor: options.composerCursor ?? composer.length,
    multiline: false,
    slashCatalog,
    slashOpen: false,
    slashIndex: 0,
    slashQuery: '',
    slashMatches: filterSlashCommands(slashCatalog, ''),
    transcript: [],
    lane: defaultLaneState({ harness: options.mode ?? 'smart', ...options.lane }),
    status: 'idle',
    panels: options.panels ?? buildPanelSummaries(options.parsed, slashCatalog, workspaceCwd),
  };
  updateSlashState(model);
  return model;
}

export function renderTuiFrame(model, size = {}) {
  const columns = Math.max(50, size.columns ?? process.stdout.columns ?? 80);
  const rows = Math.max(16, size.rows ?? process.stdout.rows ?? 24);
  const divider = '-'.repeat(columns);
  const header = [
    `Coven Code ${model.version}`.slice(0, columns),
    `${model.cwd}`.slice(0, columns),
    `${renderTabLine(model)}   mode: ${model.mode}   effort: ${model.reasoningEffort}`.slice(0, columns),
    divider,
  ];
  const status = renderCompactStatus(model).slice(0, columns);
  const composerLines = renderComposerLines(model, columns);
  const slashLines = model.slashOpen ? renderSlashOverlay(model, columns, Math.min(10, Math.max(4, rows - 10))) : [];
  const footer = [
    divider,
    ...composerLines,
    ...slashLines,
    status,
  ];
  const bodyRows = Math.max(1, rows - header.length - footer.length);
  const body = renderTabContent(model, bodyRows, columns);
  return [
    ...header,
    ...body,
    ...footer,
  ].slice(0, rows).join('\n');
}

export async function handleTuiKey(model, session, key = {}) {
  if (key.ctrl && key.name === 'c') {
    model.status = 'done';
    return;
  }

  if (isPrintableKey(key)) {
    insertComposerText(model, key.sequence);
    return;
  }

  if (key.name === 'backspace' || key.name === 'delete') {
    deleteComposerText(model, key.name);
    return;
  }

  if (key.name === 'left') {
    model.composerCursor = Math.max(0, model.composerCursor - 1);
    return;
  }

  if (key.name === 'right') {
    model.composerCursor = Math.min(model.composer.length, model.composerCursor + 1);
    return;
  }

  if (key.name === 'home') {
    model.composerCursor = 0;
    return;
  }

  if (key.name === 'end') {
    model.composerCursor = model.composer.length;
    return;
  }

  if (model.slashOpen) {
    if (key.name === 'escape') {
      closeSlashMenu(model);
      return;
    }
    if (key.name === 'down') {
      model.slashIndex = (model.slashIndex + 1) % Math.max(1, model.slashMatches.length);
      return;
    }
    if (key.name === 'up') {
      model.slashIndex = (model.slashIndex + Math.max(1, model.slashMatches.length) - 1) % Math.max(1, model.slashMatches.length);
      return;
    }
    if (key.name === 'tab') {
      completeSlashSelection(model);
      return;
    }
    if (key.name === 'enter') {
      await acceptSlashSelection(model, session);
      return;
    }
  }

  if (key.name === 'tab') {
    const index = TABS.indexOf(model.activeTab);
    model.activeTab = TABS[(index + 1) % TABS.length];
    return;
  }

  if (key.name === 'escape') {
    model.paletteOpen = false;
    return;
  }

  if (key.ctrl && key.name === 'p') {
    model.paletteOpen = true;
    model.paletteIndex = 0;
    return;
  }

  if (model.paletteOpen && key.name === 'enter') {
    const [, command] = PALETTE_ACTIONS[model.paletteIndex ?? 0] ?? PALETTE_ACTIONS[0];
    model.paletteOpen = false;
    await submitTuiText(model, session, command);
    return;
  }

  if (model.paletteOpen && key.name === 'down') {
    model.paletteIndex = (model.paletteIndex + 1) % PALETTE_ACTIONS.length;
    return;
  }

  if (model.paletteOpen && key.name === 'up') {
    model.paletteIndex = (model.paletteIndex + PALETTE_ACTIONS.length - 1) % PALETTE_ACTIONS.length;
    return;
  }

  if (key.ctrl && key.name === 'n') {
    await submitTuiText(model, session, '/new');
    return;
  }

  if (key.ctrl && key.name === 'r') {
    await submitTuiText(model, session, '/reasoning next');
    return;
  }

  if (key.ctrl && key.name === 'm') {
    const next = session.parsed.mode === 'smart' ? 'deep' : session.parsed.mode === 'deep' ? 'rush' : 'smart';
    await submitTuiText(model, session, `/mode ${next}`);
    return;
  }

  if ((key.meta || key.shift) && key.name === 'enter') {
    insertComposerText(model, '\n');
    model.multiline = true;
    return;
  }

  if (key.name === 'enter') {
    const text = model.composer.trim();
    model.composer = '';
    model.composerCursor = 0;
    closeSlashMenu(model);
    await submitTuiText(model, session, text);
  }
}

function renderTabContent(model, limit, width) {
  if (model.activeTab === 'help') return clipLines(formatSlashHelpLines(model.slashCatalog), limit, width);
  if (model.activeTab === 'lane') return renderLaneLines(model, limit, width);
  if (model.activeTab === 'tools') return clipLines(model.panels.tools, limit, width);
  if (model.activeTab === 'threads') return clipLines(model.panels.threads, limit, width);
  if (model.activeTab === 'config') return clipLines(model.panels.config, limit, width);
  return renderTranscript(model, limit, width);
}

function renderTranscript(model, limit, width) {
  const entries = model.transcript.slice(-Math.max(1, limit)).flatMap((entry) => [
    `${entry.role}:`,
    ...String(entry.text).split(/\r?\n/),
  ]);
  return clipLines(entries.length > 0 ? entries.slice(-limit) : ['Ready. Type a prompt or /help.'], limit, width);
}

function renderComposerLines(model, width) {
  const prompt = model.composer || '';
  const lines = String(prompt).split('\n');
  return lines.map((line, index) => `${index === 0 ? '> ' : '  '}${line}`.slice(0, width));
}

function renderSlashOverlay(model, width, limit) {
  const listWidth = Math.min(34, Math.floor(width * 0.38));
  const detailWidth = width - listWidth - 3;
  const matches = currentSlashMatches(model);
  const selected = matches[model.slashIndex] ?? matches[0];
  const listLines = ['Slash commands', ...matches.map((entry, index) => {
    const marker = index === model.slashIndex ? '>' : ' ';
    const status = entry.availability?.type === 'disabled' ? ' disabled' : '';
    return `${marker} ${entry.command}${status}`;
  })];
  const detailLines = ['Details', ...formatSlashCommandDetails(selected)];
  const count = Math.min(limit, Math.max(listLines.length, detailLines.length));
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const left = (listLines[index] ?? '').padEnd(listWidth).slice(0, listWidth);
    const right = (detailLines[index] ?? '').slice(0, detailWidth);
    rows.push(`${left} | ${right}`);
  }
  return rows;
}

function renderCompactStatus(model) {
  return [
    `thread: ${shortThreadId(model.threadId)}`,
    `lane: ${model.lane.branch}`,
    `harness: ${model.lane.harness}`,
    `queued: ${model.queueCount}`,
    `tools: ${model.toolCount}`,
    `tab: ${model.activeTab}`,
    `status: ${model.status}`,
  ].join('  |  ');
}

function buildPanelSummaries(parsed = {}, slashCatalog = buildStaticSlashCommandCatalog(), cwd = process.cwd()) {
  const threads = listThreads().slice(0, 8);
  const latest = threads
    .filter((thread) => !thread.archived)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  const settingsPath = settingsFile(parsed);
  const workspacePath = findWorkspaceSettingsFile(cwd);
  const settings = readEffectiveSettings(parsed, { cwd });
  return {
    tools: [
      ...builtinToolSummaryLines(),
      '',
      'Slash command sources:',
      `commands: ${slashCatalog.length}`,
    ],
    threads: [
      `Recent threads: ${threads.length}`,
      `Latest: ${latest?.id ?? 'none'}`,
      ...threads.map((thread) => `${thread.id} ${thread.archived ? 'archived' : 'active'} ${thread.title}`),
    ],
    config: [
      'Settings',
      `user: ${settingsPath}${existsSync(settingsPath) ? '' : ' (not created)'}`,
      `workspace: ${workspacePath ?? 'none'}`,
      `visibility: ${settings['covenCode.defaultVisibility'] ?? 'private'}`,
      `updates: ${settings['covenCode.updates.mode'] ?? 'default'}`,
    ],
  };
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
  model.panels = buildPanelSummaries(session.parsed, model.slashCatalog, model.workspaceCwd);
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
      height: 4,
      padding: { left: 1, right: 1 },
      style: { fg: 'white', bg: 'black' },
    });
    const transcript = blessed.box({
      top: 4,
      left: 0,
      width: '100%',
      bottom: 4,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      padding: { left: 1, right: 1 },
      scrollbar: { ch: ' ', style: { bg: 'white' } },
    });
    const composer = blessed.box({
      bottom: 1,
      left: 0,
      width: '100%',
      height: 3,
      padding: { left: 1, right: 1 },
      style: {
        border: { fg: 'green' },
      },
    });
    const status = blessed.box({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: { fg: 'white', bg: 'black' },
    });
    const palette = blessed.list({
      top: 'center',
      left: 'center',
      width: '60%',
      height: Math.min(13, PALETTE_ACTIONS.length + 2),
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
    const slashList = blessed.list({
      bottom: 4,
      left: 0,
      width: '36%',
      height: '50%',
      label: ' Slash commands ',
      border: 'line',
      hidden: true,
      keys: true,
      mouse: true,
      style: {
        border: { fg: 'cyan' },
        selected: { bg: 'blue', fg: 'white' },
      },
    });
    const slashDetails = blessed.box({
      bottom: 4,
      right: 0,
      width: '64%',
      height: '50%',
      label: ' Details ',
      border: 'line',
      hidden: true,
      padding: { left: 1, right: 1 },
      style: {
        border: { fg: 'cyan' },
      },
    });

    screen.append(header);
    screen.append(transcript);
    screen.append(composer);
    screen.append(status);
    screen.append(palette);
    screen.append(slashList);
    screen.append(slashDetails);
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
      const width = Number(screen.width) || 80;
      header.setContent(`Coven Code ${model.version}\n${model.cwd}\n${renderTabLine(model)}   mode: ${model.mode}   effort: ${model.reasoningEffort}`);
      transcript.setContent(renderTabContent(model, Math.max(1, Number(transcript.height) - 2), Math.max(20, width - 4)).join('\n'));
      composer.setContent(renderComposerLines(model, width - 4).join('\n'));
      status.setContent(renderCompactStatus(model));
      if (model.paletteOpen) {
        palette.show();
        palette.select(model.paletteIndex);
        palette.focus();
      } else {
        palette.hide();
      }
      if (model.slashOpen) {
        const matches = currentSlashMatches(model);
        const selected = matches[model.slashIndex] ?? matches[0];
        slashList.setItems(matches.map((entry) => `${entry.command}  ${entry.title}`));
        slashList.show();
        slashList.select(model.slashIndex);
        slashDetails.setContent(formatSlashCommandDetails(selected).join('\n'));
        slashDetails.show();
      } else {
        slashList.hide();
        slashDetails.hide();
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
      const normalized = normalizeBlessedKey({
        ...key,
        sequence: isPrintableChunk(chunk, key) ? chunk : key.sequence,
      });
      await dispatchKey(normalized);
    });

    screen.on('resize', sync);
    sync();
  });
}

function renderTabLine(model) {
  return TABS.map((tab) => tab === model.activeTab ? `[${tab}]` : ` ${tab} `).join(' ');
}

function insertComposerText(model, text) {
  model.composer = `${model.composer.slice(0, model.composerCursor)}${text}${model.composer.slice(model.composerCursor)}`;
  model.composerCursor += text.length;
  updateSlashState(model);
}

function deleteComposerText(model, kind) {
  if (kind === 'delete') {
    if (model.composerCursor >= model.composer.length) return;
    model.composer = `${model.composer.slice(0, model.composerCursor)}${model.composer.slice(model.composerCursor + 1)}`;
  } else {
    if (model.composerCursor <= 0) return;
    model.composer = `${model.composer.slice(0, model.composerCursor - 1)}${model.composer.slice(model.composerCursor)}`;
    model.composerCursor -= 1;
  }
  updateSlashState(model);
}

function updateSlashState(model) {
  const beforeCursor = model.composer.slice(0, model.composerCursor);
  const active = beforeCursor.startsWith('/') && !/\s/.test(beforeCursor.slice(1));
  if (!active) {
    closeSlashMenu(model);
    return;
  }
  model.slashOpen = true;
  model.slashQuery = beforeCursor.replace(/^\/+/, '');
  model.slashMatches = filterSlashCommands(model.slashCatalog, beforeCursor);
  if (model.slashMatches.length === 0) model.slashIndex = 0;
  else model.slashIndex = Math.min(model.slashIndex, model.slashMatches.length - 1);
}

function closeSlashMenu(model) {
  model.slashOpen = false;
  model.slashQuery = '';
  model.slashMatches = filterSlashCommands(model.slashCatalog, '');
  model.slashIndex = 0;
}

function completeSlashSelection(model) {
  const selected = currentSlashMatches(model)[model.slashIndex];
  if (!selected) return;
  model.composer = `${selected.command} `;
  model.composerCursor = model.composer.length;
  closeSlashMenu(model);
}

async function acceptSlashSelection(model, session) {
  const selected = currentSlashMatches(model)[model.slashIndex];
  if (!selected) return;
  const command = selected.command;
  model.composer = '';
  model.composerCursor = 0;
  closeSlashMenu(model);
  await submitTuiText(model, session, command);
}

function currentSlashMatches(model) {
  return model.slashMatches.length > 0 ? model.slashMatches : filterSlashCommands(model.slashCatalog, model.slashQuery);
}

function clipLines(lines, limit, width) {
  return lines
    .slice(0, Math.max(0, limit))
    .map((line) => String(line).slice(0, width));
}

function shortThreadId(threadId) {
  if (!threadId || threadId === 'new thread') return 'new';
  return String(threadId).slice(0, 14);
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

function isPrintableKey(key = {}) {
  return isPrintableChunk(key.sequence, key);
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

async function safeBuildSlashCommandCatalog(parsed) {
  try {
    return await buildSlashCommandCatalog({ parsed, cwd: process.cwd() });
  } catch {
    return buildStaticSlashCommandCatalog();
  }
}
