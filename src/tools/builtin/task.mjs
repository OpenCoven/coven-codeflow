import { fixtureAgentResponse } from '../../agent/fixture.mjs';
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

export const TOOL_NAME = 'Task';

export async function executePromptTaskToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled(TOOL_NAME, 'built-in', parsed)) return { output: `Tool disabled: ${TOOL_NAME}` };
  request = { ...request, flags: normalizeTaskInput(request.flags) };
  if (!request.flags.prompt) return { output: 'Task requires --prompt' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(TOOL_NAME, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(TOOL_NAME, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(TOOL_NAME, request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeTaskInput(callResult.request.flags) };
  const decision = resolvePermissionDecision(TOOL_NAME, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(TOOL_NAME, decision),
      permissionDenials: [{ tool: TOOL_NAME, action: decision.action, reason: 'permission' }],
    };
  }
  const output = fixtureAgentResponse(request.flags.prompt, '');
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(TOOL_NAME, request.flags, 'done', output, threadId, toolUseID),
  );
  const finalResult = pluginTextToolRunResult(resultDecision, output);
  return {
    output: finalResult.output,
    exitCode: finalResult.exitCode,
    subagentMessages: [{ text: finalResult.output }],
    toolResultParentToolUseId: null,
    finalParentToolUseId: null,
    toolUse: pluginToolUseBlock(TOOL_NAME, request.flags, toolUseID),
  };
}

function normalizeTaskInput(input = {}) {
  const prompt = input.prompt ?? input.task ?? input.instructions ?? input.message;
  const description = input.description ?? input.title ?? input.name ?? 'subagent task';
  return {
    ...input,
    description: String(description ?? 'subagent task'),
    prompt: prompt ? String(prompt) : '',
  };
}
