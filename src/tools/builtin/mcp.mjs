import { resolvePermissionDecision } from '../../commands/permissions.mjs';
import { listConfiguredMcpServers } from '../../mcp/discover.mjs';
import { callMcpTool, isMcpToolIncluded, parseMcpToolName } from '../../mcp/probe.mjs';
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

export async function executePromptMcpToolRequest(request, parsed = {}, threadId = '', plugins = { handlers: {} }) {
  const parsedName = parseMcpToolName(request.toolName);
  if (!parsedName) return { output: `Unknown tool: ${request.toolName}` };
  if (isToolDisabled(request.toolName, 'local-mcp', parsed)) return { output: `Tool disabled: ${request.toolName}` };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(request.toolName, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(request.toolName, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(request.toolName, request.flags, toolUseID, callResult);
  request = callResult.request;
  const decision = resolvePermissionDecision(request.toolName, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(request.toolName, decision),
      permissionDenials: [{ tool: request.toolName, action: decision.action, reason: 'permission' }],
    };
  }
  const server = listConfiguredMcpServers(parsed)
    .find((entry) => entry.name === parsedName.serverName && entry.status === 'approved');
  if (!server) return { output: `Unknown MCP server: ${parsedName.serverName}` };
  if (!isMcpToolIncluded(server.config, parsedName.toolName)) return { output: `Tool not available: ${request.toolName}` };
  const output = await callMcpTool(server.config, parsedName.toolName, request.flags, server.name);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(request.toolName, request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock(request.toolName, request.flags, toolUseID),
  };
}
