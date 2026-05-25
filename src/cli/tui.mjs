import readline from 'node:readline';
import { runInteractive } from './repl.mjs';
import { VERSION } from '../constants.mjs';
import { createInteractiveSession, handleInteractiveInput, slashHelpLines } from './interactive-core.mjs';

const TABS = ['chat', 'tools', 'threads', 'config', 'help'];
const PALETTE_ACTIONS = [
  ['New thread', '/new'],
  ['Continue latest thread', '/continue'],
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
  const result = await handleInteractiveInput(session, text);
  model.mode = session.parsed.mode;
  model.reasoningEffort = session.parsed.reasoningEffort ?? model.reasoningEffort;
  model.threadId = session.thread?.id ?? 'new thread';
  model.queueCount = session.queuedMessages.length;
  if (result.lines.length > 0) {
    model.transcript.push({
      role: result.kind === 'error' ? 'error' : 'coven',
      text: result.lines.join('\n'),
    });
  }
  model.status = result.kind === 'exit' ? 'done' : 'idle';
}

async function runLiveTui(model, session) {
  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  const redraw = () => {
    process.stdout.write(`\x1b[2J\x1b[H${renderTuiFrame(model)}\n`);
  };
  redraw();
  return new Promise((resolve) => {
    const cleanup = () => {
      process.stdin.off('keypress', onKeypress);
      process.stdin.setRawMode?.(Boolean(wasRaw));
      process.stdout.write('\x1b[?25h');
      resolve();
    };
    const onKeypress = async (chunk, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        return;
      }
      if (key.name === 'backspace') {
        model.composer = model.composer.slice(0, -1);
      } else if (chunk && !key.ctrl && !key.meta && key.name !== 'return' && key.name !== 'enter' && key.name !== 'tab') {
        model.composer += chunk;
      } else {
        await handleTuiKey(model, session, key.name === 'return' ? { ...key, name: 'enter' } : key);
      }
      redraw();
      if (model.status === 'done') cleanup();
    };
    process.stdin.on('keypress', onKeypress);
  });
}
