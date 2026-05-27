import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePermissionDecision } from '../../commands/permissions.mjs';
import { runPluginEventHandlers } from '../../plugins/discover.mjs';
import { detectImageMediaType } from '../../util/media.mjs';
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

export const TOOL_NAME = 'look_at';

export async function executePromptLookAtToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled(TOOL_NAME, 'built-in', parsed)) return { output: `Tool disabled: ${TOOL_NAME}` };
  request = { ...request, flags: normalizeLookAtInput(request.flags) };
  if (!request.flags.path) return { output: 'look_at requires --path' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(TOOL_NAME, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(TOOL_NAME, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(TOOL_NAME, request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeLookAtInput(callResult.request.flags) };
  const decision = resolvePermissionDecision(TOOL_NAME, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(TOOL_NAME, decision),
      permissionDenials: [{ tool: TOOL_NAME, action: decision.action, reason: 'permission' }],
    };
  }
  const output = inspectLookAtMedia(request.flags);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(TOOL_NAME, request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock(TOOL_NAME, request.flags, toolUseID),
  };
}

function normalizeLookAtInput(input = {}) {
  const source = input.path ?? input.file ?? input.image ?? input.pdf ?? input.url;
  const goal = input.goal ?? input.prompt ?? input.instructions ?? input.question ?? '';
  return {
    ...input,
    path: source ? String(source) : '',
    goal: String(goal),
  };
}

function inspectLookAtMedia(input) {
  try {
    const resolved = resolveLookAtPath(input.path);
    const raw = readFileSync(resolved);
    return formatLookAtMediaResult(input.path, raw, input.goal);
  } catch (error) {
    return `Unable to look at ${input.path}: ${error.message}`;
  }
}

function resolveLookAtPath(source) {
  if (source.startsWith('file://')) return fileURLToPath(source);
  return path.resolve(process.cwd(), source);
}

function formatLookAtMediaResult(source, raw, goal) {
  return [
    `Looked at: ${source}`,
    `media_type: ${detectLookAtMediaType(raw)}`,
    `bytes: ${raw.length}`,
    `goal: ${goal || '(none)'}`,
  ].join('\n');
}

function detectLookAtMediaType(raw) {
  const imageType = detectImageMediaType(raw);
  if (imageType) return imageType;
  if (raw.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return 'application/octet-stream';
}
