import { runInteractive } from './repl.mjs';
import { VERSION } from '../constants.mjs';
import { slashHelpLines } from './interactive-core.mjs';

const TABS = ['chat', 'tools', 'threads', 'config', 'help'];

export async function runTuiInteractive(parsed, initialInput = '') {
  return runInteractive(parsed, initialInput);
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
