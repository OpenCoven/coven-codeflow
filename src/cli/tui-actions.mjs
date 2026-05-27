import { CLI_NAME } from '../constants.mjs';
import {
  inspectLane,
  nextLaneHarness,
  normalizeLaneHarness,
  runLaneVerification,
} from '../agent/lane.mjs';
import { splitShellWords } from '../util/shell.mjs';
import { handleInteractiveInput } from './interactive-core.mjs';
import {
  buildSlashCommandCatalog,
  buildStaticSlashCommandCatalog,
  filterSlashCommands,
} from './slash-commands.mjs';
import { buildPanelSummaries, currentSlashMatches, renderLaneLines } from './tui-render.mjs';

export async function submitTuiText(model, session, text) {
  if (!text) return;
  model.transcript.push({ role: 'you', text });
  model.status = 'running';
  let result;
  let stdout = '';
  let stderr = '';
  if (isLaneCommand(text)) {
    ({ result, stdout, stderr } = await handleTuiLaneCommand(model, session, text));
  } else {
    const priorThreadId = session.thread?.id;
    const priorMessageCount = session.thread?.messages?.length ?? 0;
    ({ result, stderr } = await captureTerminalOutput(() => handleInteractiveInput(session, text)));
    stdout = newAssistantText(session.thread, priorThreadId, priorMessageCount);
  }
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

function newAssistantText(thread, priorThreadId, priorMessageCount) {
  if (!thread?.messages?.length) return '';
  const startIndex = thread.id === priorThreadId ? priorMessageCount : 0;
  return thread.messages
    .slice(startIndex)
    .filter((message) => message.role === 'assistant' && typeof message.content === 'string')
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n');
}

export function insertComposerText(model, text) {
  model.composer = `${model.composer.slice(0, model.composerCursor)}${text}${model.composer.slice(model.composerCursor)}`;
  model.composerCursor += text.length;
  updateSlashState(model);
}

export function deleteComposerText(model, kind) {
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

export function updateSlashState(model) {
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

export function closeSlashMenu(model) {
  model.slashOpen = false;
  model.slashQuery = '';
  model.slashMatches = filterSlashCommands(model.slashCatalog, '');
  model.slashIndex = 0;
}

export function completeSlashSelection(model) {
  const selected = currentSlashMatches(model)[model.slashIndex];
  if (!selected) return;
  model.composer = `${selected.command} `;
  model.composerCursor = model.composer.length;
  closeSlashMenu(model);
}

export async function acceptSlashSelection(model, session) {
  const selected = currentSlashMatches(model)[model.slashIndex];
  if (!selected) return;
  const command = selected.command;
  model.composer = '';
  model.composerCursor = 0;
  closeSlashMenu(model);
  await submitTuiText(model, session, command);
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

async function captureTerminalOutput(fn) {
  let stderr = '';
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = function tuiStdoutWrite(chunk, encoding, callback) {
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
    return { result, stderr };
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

export async function safeBuildSlashCommandCatalog(parsed) {
  try {
    return await buildSlashCommandCatalog({ parsed, cwd: process.cwd() });
  } catch {
    return buildStaticSlashCommandCatalog();
  }
}
