import { randomUUID } from 'node:crypto';
import path from 'node:path';

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

export function pluginToolResultDecisionOutput(resultDecision = {}, fallback) {
  validateToolResultDecision(resultDecision);
  if (resultDecision.status === 'error') {
    return resultDecision.error ?? resultDecision.output ?? fallback;
  }
  if (resultDecision.status === 'cancelled') {
    return resultDecision.error ?? resultDecision.output ?? 'Tool cancelled';
  }
  return resultDecision.output !== undefined ? resultDecision.output : fallback;
}

export function pluginToolResultDecisionExitCode(resultDecision = {}, fallback = 0) {
  validateToolResultDecision(resultDecision);
  if (resultDecision.status === 'error' || resultDecision.status === 'cancelled') return 1;
  if (resultDecision.status === 'done') return 0;
  return fallback;
}

export function validateToolResultDecision(resultDecision = {}) {
  if (!resultDecision || typeof resultDecision !== 'object' || !Object.hasOwn(resultDecision, 'status')) return;
  if (resultDecision.status !== 'done' && resultDecision.status !== 'error' && resultDecision.status !== 'cancelled') {
    throw new Error('plugin tool.result status must be done, error, or cancelled');
  }
  const allowedKeys = resultDecision.status === 'done' ? ['output', 'status'] : ['error', 'output', 'status'];
  if (Object.keys(resultDecision).some((key) => !allowedKeys.includes(key))) {
    throw new Error('plugin tool.result fields must match the documented union');
  }
  if (
    (resultDecision.status === 'error' || resultDecision.status === 'cancelled') &&
    resultDecision.error !== undefined &&
    typeof resultDecision.error !== 'string'
  ) {
    throw new Error('plugin tool.result error must be a string');
  }
}

export function toolResultContent(toolRun = {}) {
  return Object.hasOwn(toolRun, 'toolResultOutput') ? toolRun.toolResultOutput : toolRun.output;
}

export function normalizePluginToolOutput(output) {
  if (Array.isArray(output) && output.every(isPluginContentBlock)) {
    const text = output.map(pluginContentBlockText).filter(Boolean).join('\n').trimEnd();
    return { raw: output, text };
  }
  const text = String(output ?? '').trimEnd();
  return { raw: text, text };
}

export function normalizePluginToolExecuteOutput(output) {
  if (output === undefined || typeof output === 'string') return normalizePluginToolOutput(output);
  if (Array.isArray(output)) {
    if (!output.every(isPluginContentBlock)) {
      throw new Error('plugin tool result content blocks must be text or image blocks');
    }
    return normalizePluginToolOutput(output);
  }
  throw new Error('plugin tool result must be a string, content blocks, or undefined');
}

export function isPluginContentBlock(block) {
  if (!block || typeof block !== 'object') return false;
  if (block.type === 'text') return typeof block.text === 'string';
  if (block.type === 'image') return typeof block.mimeType === 'string' && typeof block.data === 'string';
  return false;
}

export function pluginContentBlockText(block) {
  if (block.type === 'text') return block.text;
  return '';
}

export function applyToolCallDecision(toolName, request, callDecision = { action: 'allow' }) {
  validateToolCallDecision(callDecision);
  if (callDecision.action === 'allow') return { request };
  if (callDecision.action === 'reject-and-continue') {
    if (typeof callDecision.message !== 'string') {
      throw new Error('plugin tool.call reject-and-continue message must be a string');
    }
    return {
      output: {
        output: callDecision.message,
        exitCode: 0,
      },
    };
  }
  if (callDecision.action === 'synthesize') {
    const result = callDecision.result && isPlainObject(callDecision.result)
      ? callDecision.result
      : callDecision;
    if (typeof result.output !== 'string') {
      throw new Error('plugin tool.call synthesize result.output must be a string');
    }
    if (result.exitCode !== undefined && !Number.isInteger(result.exitCode)) {
      throw new Error('plugin tool.call synthesize result.exitCode must be an integer');
    }
    return {
      output: {
        output: result.output.trimEnd(),
        exitCode: result.exitCode ?? 0,
      },
    };
  }
  if (callDecision.action === 'error') {
    if (typeof callDecision.message !== 'string') {
      throw new Error('plugin tool.call error message must be a string');
    }
    return {
      output: {
        output: callDecision.message,
        exitCode: 1,
      },
    };
  }
  if (callDecision.action === 'modify') {
    if (!isPlainObject(callDecision.input)) {
      throw new Error('plugin tool.call modify input must be an object');
    }
    return { request: { ...request, flags: callDecision.input } };
  }
  return { request };
}

export function validateToolCallDecision(callDecision) {
  if (!callDecision || typeof callDecision !== 'object') {
    throw new Error('plugin tool.call result must be an object');
  }
  if (
    callDecision.action !== 'allow' &&
    callDecision.action !== 'reject-and-continue' &&
    callDecision.action !== 'modify' &&
    callDecision.action !== 'synthesize' &&
    callDecision.action !== 'error'
  ) {
    throw new Error('plugin tool.call action must be allow, reject-and-continue, modify, synthesize, or error');
  }
  const allowedKeys = {
    allow: ['action'],
    'reject-and-continue': ['action', 'message'],
    modify: ['action', 'input'],
    synthesize: ['action', 'result'],
    error: ['action', 'message'],
  }[callDecision.action];
  if (Object.keys(callDecision).some((key) => !allowedKeys.includes(key))) {
    throw new Error('plugin tool.call fields must match the documented union');
  }
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
