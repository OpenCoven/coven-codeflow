import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  pluginToolResultDecisionExitCode,
  pluginToolResultDecisionOutput,
} from './runtime-decisions.mjs';

export {
  applyToolCallDecision,
  pluginToolResultDecisionExitCode,
  pluginToolResultDecisionOutput,
  validateToolCallDecision,
  validateToolResultDecision,
} from './runtime-decisions.mjs';
export {
  isPluginContentBlock,
  normalizePluginToolExecuteOutput,
  normalizePluginToolOutput,
  pluginContentBlockText,
} from './runtime-content.mjs';

export function createToolUseID() {
  return `toolu_${randomUUID()}`;
}

export function relativeToolPath(filePath) {
  const relative = path.relative(process.cwd(), filePath);
  return relative && !relative.startsWith('..') ? relative : filePath;
}

export function pluginToolCallEvent(tool, input, threadId, toolUseID = createToolUseID()) {
  return {
    toolUseID,
    tool,
    input,
    thread: { id: threadId },
  };
}

export function pluginToolResultEvent(tool, input, status, output, threadId, toolUseID, error) {
  return {
    toolUseID,
    tool,
    input,
    status,
    output,
    ...(error ? { error } : {}),
    thread: { id: threadId },
  };
}

export function pluginToolUseBlock(tool, input, toolUseID) {
  return {
    type: 'tool_use',
    id: toolUseID,
    name: tool,
    input,
  };
}

export function toolResultContent(toolRun = {}) {
  return Object.hasOwn(toolRun, 'toolResultOutput') ? toolRun.toolResultOutput : toolRun.output;
}

export function toolCallDecisionToolRun(toolName, input, toolUseID, callResult) {
  return {
    ...callResult.output,
    toolUse: pluginToolUseBlock(toolName, input, toolUseID),
  };
}

export function pluginResultOutput(resultDecision, output) {
  return String(pluginToolResultDecisionOutput(resultDecision, output) ?? '').trimEnd();
}

export function pluginTextToolRunResult(resultDecision, output, fallbackExitCode = 0) {
  return {
    output: pluginResultOutput(resultDecision, output),
    exitCode: pluginToolResultDecisionExitCode(resultDecision, fallbackExitCode),
  };
}

export function permissionDeniedOutput(toolName, decision) {
  return decision.message ? `Permission denied for ${toolName}: ${decision.message}` : `Permission denied for ${toolName}`;
}
