import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_SUBDIR } from '../../constants.mjs';
import { resolvePermissionDecision } from '../../commands/permissions.mjs';
import { runPluginEventHandlers } from '../../plugins/discover.mjs';
import { configDir } from '../../settings/paths.mjs';
import { isToolDisabled } from '../toolbox.mjs';
import {
  applyToolCallDecision,
  createToolUseID,
  permissionDeniedOutput,
  pluginTextToolRunResult,
  pluginToolCallEvent,
  pluginToolResultEvent,
  pluginToolUseBlock,
  toolCallDecisionToolRun,
  validateToolCallDecision,
} from './runtime.mjs';

export const TOOL_NAME = 'undo_edit';

export async function executePromptUndoEditToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled(TOOL_NAME, 'built-in', parsed)) return { output: `Tool disabled: ${TOOL_NAME}` };
  request = { ...request, flags: normalizeUndoEditInput(request.flags) };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(TOOL_NAME, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(TOOL_NAME, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(TOOL_NAME, request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeUndoEditInput(callResult.request.flags) };
  const decision = resolvePermissionDecision(TOOL_NAME, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(TOOL_NAME, decision),
      permissionDenials: [{ tool: TOOL_NAME, action: decision.action, reason: 'permission' }],
    };
  }
  const undoResult = undoBuiltinEdit(threadId, request.flags.path);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(TOOL_NAME, request.flags, undoResult.status, undoResult.output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, undoResult.output, undoResult.status === 'done' ? 0 : 1),
    toolUse: pluginToolUseBlock(TOOL_NAME, request.flags, toolUseID),
  };
}

function normalizeUndoEditInput(input = {}) {
  const filePath = input.path ?? input.file ?? input.file_path;
  return {
    ...input,
    path: filePath ? String(filePath) : '',
  };
}

export function recordEditUndo(threadId, entry) {
  const entries = readEditUndoEntries(threadId);
  const filePath = editUndoFile(threadId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify([...entries, { ...entry, createdAt: new Date().toISOString() }], null, 2)}\n`);
}

function undoBuiltinEdit(threadId, filePath = '') {
  const entries = readEditUndoEntries(threadId);
  const absolutePath = filePath ? path.resolve(process.cwd(), filePath) : '';
  const index = findUndoEntryIndex(entries, filePath, absolutePath);
  if (index === -1) return { status: 'error', output: filePath ? `No edit to undo for ${filePath}` : 'No edit to undo' };
  const [entry] = entries.splice(index, 1);
  writeFileSync(entry.absolutePath, entry.content, 'utf8');
  writeFileSync(editUndoFile(threadId), `${JSON.stringify(entries, null, 2)}\n`);
  return { status: 'done', output: `Undid edit to ${entry.path}` };
}

function findUndoEntryIndex(entries, filePath, absolutePath) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!filePath || entry.path === filePath || entry.absolutePath === absolutePath) return index;
  }
  return -1;
}

function readEditUndoEntries(threadId) {
  try {
    const parsed = JSON.parse(readFileSync(editUndoFile(threadId), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function editUndoFile(threadId) {
  return path.join(configDir(), CONFIG_SUBDIR, 'undo', `${threadId || 'global'}.json`);
}
