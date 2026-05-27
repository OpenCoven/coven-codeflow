import { mkdirSync, writeFileSync } from 'node:fs';
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

export const TOOL_NAME = 'create_file';

export async function executePromptCreateFileToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled(TOOL_NAME, 'built-in', parsed)) return { output: `Tool disabled: ${TOOL_NAME}` };
  request = { ...request, flags: normalizeCreateFileInput(request.flags) };
  if (!request.flags.path) return { output: 'create_file requires --path' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(TOOL_NAME, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(TOOL_NAME, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(TOOL_NAME, request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeCreateFileInput(callResult.request.flags) };
  const decision = resolvePermissionDecision(TOOL_NAME, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(TOOL_NAME, decision),
      permissionDenials: [{ tool: TOOL_NAME, action: decision.action, reason: 'permission' }],
    };
  }
  const output = createBuiltinFile(request.flags.path, request.flags.content);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(TOOL_NAME, request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock(TOOL_NAME, request.flags, toolUseID),
  };
}

function normalizeCreateFileInput(input = {}) {
  const filePath = input.path ?? input.file ?? input.file_path;
  const content = input.content ?? input.text ?? input.body ?? '';
  return {
    ...input,
    path: filePath ? String(filePath) : '',
    content: String(content ?? ''),
  };
}

function createBuiltinFile(filePath, content) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, { encoding: 'utf8', flag: 'wx' });
  return `Created ${filePath}`;
}
