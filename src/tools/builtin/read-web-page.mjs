import { resolvePermissionDecision } from '../../commands/permissions.mjs';
import { runPluginEventHandlers } from '../../plugins/discover.mjs';
import { htmlToText } from '../../util/html.mjs';
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

export const TOOL_NAME = 'read_web_page';

export async function executePromptReadWebPageToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled(TOOL_NAME, 'built-in', parsed)) return { output: `Tool disabled: ${TOOL_NAME}` };
  request = { ...request, flags: normalizeReadWebPageInput(request.flags) };
  if (!request.flags.url) return { output: 'read_web_page requires --url' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(TOOL_NAME, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(TOOL_NAME, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(TOOL_NAME, request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeReadWebPageInput(callResult.request.flags) };
  const decision = resolvePermissionDecision(TOOL_NAME, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(TOOL_NAME, decision),
      permissionDenials: [{ tool: TOOL_NAME, action: decision.action, reason: 'permission' }],
    };
  }
  const output = await readWebPageBuiltin(request.flags.url);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(TOOL_NAME, request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock(TOOL_NAME, request.flags, toolUseID),
  };
}

function normalizeReadWebPageInput(input = {}) {
  const url = input.url ?? input.uri ?? input.href;
  return {
    ...input,
    url: url ? String(url) : '',
  };
}

async function readWebPageBuiltin(url) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'coven-code/0.0.0' },
    });
    if (!response.ok) return `Failed to read ${url}: HTTP ${response.status}`;
    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();
    return contentType.includes('html') || body.includes('<')
      ? htmlToText(body)
      : body.trimEnd();
  } catch (error) {
    return `Failed to read ${url}: ${error.message}`;
  }
}
