import { resolvePermissionDecision } from '../../commands/permissions.mjs';
import { createPluginToolContext, runPluginEventHandlers } from '../../plugins/discover.mjs';
import { isToolDisabled } from '../toolbox.mjs';
import {
  applyToolCallDecision,
  createToolUseID,
  normalizePluginToolExecuteOutput,
  normalizePluginToolOutput,
  permissionDeniedOutput,
  pluginToolCallEvent,
  pluginToolResultDecisionExitCode,
  pluginToolResultDecisionOutput,
  pluginToolResultEvent,
  pluginToolUseBlock,
  toolCallDecisionToolRun,
  validateToolCallDecision,
} from './runtime.mjs';

export async function executePromptPluginToolRequest(tool, request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled(tool.name, 'plugin', parsed)) return { output: `Tool disabled: ${tool.name}` };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(tool.name, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(tool.name, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(tool.name, request.flags, toolUseID, callResult);
  request = callResult.request;
  const decision = resolvePermissionDecision(tool.name, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(tool.name, decision),
      permissionDenials: [{ tool: tool.name, action: decision.action, reason: 'permission' }],
    };
  }
  const output = typeof tool.execute === 'function' ? await tool.execute(request.flags, createPluginToolContext()) : undefined;
  const normalizedOutput = normalizePluginToolExecuteOutput(output);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(tool.name, request.flags, 'done', normalizedOutput.raw, threadId, toolUseID),
  );
  const finalOutput = normalizePluginToolOutput(
    pluginToolResultDecisionOutput(resultDecision, normalizedOutput.raw),
  );
  const exitCode = pluginToolResultDecisionExitCode(resultDecision);
  return {
    output: finalOutput.text,
    toolResultOutput: finalOutput.raw,
    exitCode,
    toolUse: pluginToolUseBlock(tool.name, request.flags, toolUseID),
  };
}
