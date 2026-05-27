import { resolvePermissionDecision } from '../../commands/permissions.mjs';
import { runPluginEventHandlers } from '../../plugins/discover.mjs';
import { executeToolboxTool, isToolDisabled, listToolboxTools, normalizeToolName } from '../toolbox.mjs';
import {
  applyToolCallDecision,
  createToolUseID,
  permissionDeniedOutput,
  pluginResultOutput,
  pluginToolCallEvent,
  pluginToolResultDecisionExitCode,
  pluginToolResultEvent,
  pluginToolUseBlock,
  validateToolCallDecision,
} from './runtime.mjs';

export async function executePromptToolboxToolRequest(request, stdin = '', parsed = {}, plugins = { handlers: {} }, threadId = '') {
  const toolboxName = normalizeToolName(request.toolName);
  const tool = listToolboxTools(parsed).find((entry) => entry.name === toolboxName);
  if (!tool) return { output: `Unknown tool: ${request.toolName}` };
  if (isToolDisabled(tool.name, 'toolbox', parsed)) return { output: `Tool disabled: ${tool.name}` };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(tool.name, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(tool.name, request, callDecision);
  if (callResult.output) {
    return {
      ...callResult.output,
      toolUse: pluginToolUseBlock(tool.name, request.flags, toolUseID),
    };
  }
  request.flags = callResult.request.flags;
  const decision = resolvePermissionDecision(tool.name, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(tool.name, decision),
      permissionDenials: [{ tool: tool.name, action: decision.action, reason: 'permission' }],
    };
  }
  const result = executeToolboxTool(tool, request.flags, stdin, threadId);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 0;
  const output = result.stdout.trimEnd();
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(tool.name, request.flags, (result.status ?? 0) === 0 ? 'done' : 'error', output, threadId, toolUseID),
  );
  const finalOutput = pluginResultOutput(resultDecision, output);
  const exitCode = pluginToolResultDecisionExitCode(resultDecision, result.status ?? 0);
  return {
    output: finalOutput,
    exitCode,
    toolUse: pluginToolUseBlock(tool.name, request.flags, toolUseID),
  };
}
