import { resolvePermissionDecision } from '../../commands/permissions.mjs';
import { runPluginEventHandlers } from '../../plugins/discover.mjs';
import { listThreads, threadSearchText } from '../../threads/store.mjs';
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

export const TOOL_NAME = 'finder';

export async function executePromptFinderToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '', toolName = TOOL_NAME) {
  if (isToolDisabled(toolName, 'built-in', parsed)) return { output: `Tool disabled: ${toolName}` };
  request = { ...request, flags: normalizeFinderInput(request.flags) };
  if (!request.flags.query) return { output: `${toolName} requires --query` };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(toolName, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(toolName, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(toolName, request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeFinderInput(callResult.request.flags) };
  const decision = resolvePermissionDecision(toolName, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(toolName, decision),
      permissionDenials: [{ tool: toolName, action: decision.action, reason: 'permission' }],
    };
  }
  const output = findThreadsBuiltin(request.flags.query, request.flags.limit);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(toolName, request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock(toolName, request.flags, toolUseID),
  };
}

function normalizeFinderInput(input = {}) {
  const query = input.query ?? input.q ?? input.search ?? input.task ?? input.file;
  const limit = Number.parseInt(String(input.limit ?? input.count ?? 10), 10);
  return {
    ...input,
    query: query ? String(query) : '',
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 10,
  };
}

function findThreadsBuiltin(query, limit = 10) {
  const normalizedQuery = query.toLowerCase();
  const rows = listThreads()
    .filter((thread) => threadSearchText(thread).toLowerCase().includes(normalizedQuery))
    .slice(0, limit)
    .map((thread) => [
      thread.id,
      thread.archived ? 'archived' : 'active',
      thread.visibility ?? 'private',
      thread.labels?.length ? thread.labels.join(',') : '-',
      thread.title,
    ].join('\t'));
  return rows.length ? rows.join('\n') : `No threads found for ${query}`;
}
