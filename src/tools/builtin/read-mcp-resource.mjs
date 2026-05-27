import { resolvePermissionDecision } from '../../commands/permissions.mjs';
import { listActiveMcpServerEntries } from '../../mcp/discover.mjs';
import { readMcpResource } from '../../mcp/probe.mjs';
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

export const TOOL_NAME = 'read_mcp_resource';

export async function executePromptReadMcpResourceToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled(TOOL_NAME, 'built-in', parsed)) return { output: `Tool disabled: ${TOOL_NAME}` };
  request = { ...request, flags: normalizeReadMcpResourceInput(request.flags) };
  if (!request.flags.server) return { output: 'read_mcp_resource requires --server' };
  if (!request.flags.uri) return { output: 'read_mcp_resource requires --uri' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(TOOL_NAME, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(TOOL_NAME, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(TOOL_NAME, request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeReadMcpResourceInput(callResult.request.flags) };
  const decision = resolvePermissionDecision(TOOL_NAME, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(TOOL_NAME, decision),
      permissionDenials: [{ tool: TOOL_NAME, action: decision.action, reason: 'permission' }],
    };
  }
  const server = listActiveMcpServerEntries(parsed, '')
    .find((entry) => entry.name === request.flags.server);
  if (!server) return { output: `Unknown MCP server: ${request.flags.server}` };
  const output = await readMcpResource(server.config, request.flags.uri, server.name);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(TOOL_NAME, request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock(TOOL_NAME, request.flags, toolUseID),
  };
}

function normalizeReadMcpResourceInput(input = {}) {
  const server = input.server ?? input.name ?? input.mcp_server;
  const uri = input.uri ?? input.url ?? input.resource;
  return {
    ...input,
    server: server ? String(server) : '',
    uri: uri ? String(uri) : '',
  };
}
