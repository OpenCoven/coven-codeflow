import { handleInteractiveInput } from './interactive-core.mjs';
import { buildPanelSummaries } from './tui-render.mjs';
import { handleTuiLaneCommand, isLaneCommand, rememberLaneTerminal } from './tui-lane.mjs';

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
