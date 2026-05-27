import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolvePermissionDecision } from '../../commands/permissions.mjs';
import { runPluginEventHandlers } from '../../plugins/discover.mjs';
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
import { recordEditUndo } from './undo-edit.mjs';

export const TOOL_NAME = 'edit_file';

export async function executePromptEditFileToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled(TOOL_NAME, 'built-in', parsed)) return { output: `Tool disabled: ${TOOL_NAME}` };
  request = { ...request, flags: normalizeEditFileInput(request.flags) };
  if (!request.flags.path) return { output: 'edit_file requires --path' };
  if (!request.flags.old_string) return { output: 'edit_file requires --old' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(TOOL_NAME, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(TOOL_NAME, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(TOOL_NAME, request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeEditFileInput(callResult.request.flags) };
  const decision = resolvePermissionDecision(TOOL_NAME, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(TOOL_NAME, decision),
      permissionDenials: [{ tool: TOOL_NAME, action: decision.action, reason: 'permission' }],
    };
  }
  const editResult = editBuiltinFile(request.flags.path, request.flags.old_string, request.flags.new_string, threadId);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(TOOL_NAME, request.flags, editResult.status, editResult.output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, editResult.output, editResult.status === 'done' ? 0 : 1),
    toolUse: pluginToolUseBlock(TOOL_NAME, request.flags, toolUseID),
  };
}

function normalizeEditFileInput(input = {}) {
  const filePath = input.path ?? input.file ?? input.file_path;
  const oldString = input.old_string ?? input.old ?? input.search ?? input.find;
  const newString = input.new_string ?? input.new ?? input.replacement ?? input.replace ?? '';
  return {
    ...input,
    path: filePath ? String(filePath) : '',
    old: oldString ? String(oldString) : '',
    new: String(newString ?? ''),
    old_string: oldString ? String(oldString) : '',
    new_string: String(newString ?? ''),
  };
}

function editBuiltinFile(filePath, oldString, newString, threadId = '') {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const current = readFileSync(absolutePath, 'utf8');
  if (!current.includes(oldString)) {
    return { status: 'error', output: `No match found in ${filePath}` };
  }
  recordEditUndo(threadId, { path: filePath, absolutePath, content: current });
  writeFileSync(absolutePath, current.replace(oldString, newString), 'utf8');
  return { status: 'done', output: `Edited ${filePath}` };
}
