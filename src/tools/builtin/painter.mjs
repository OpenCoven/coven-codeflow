import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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

export const TOOL_NAME = 'painter';

const PAINTER_PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFeAKU5XgS2wAAAABJRU5ErkJggg==',
  'base64',
);

export async function executePromptPainterToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled(TOOL_NAME, 'built-in', parsed)) return { output: `Tool disabled: ${TOOL_NAME}` };
  request = { ...request, flags: normalizePainterInput(request.flags) };
  if (!request.flags.prompt) return { output: 'painter requires --prompt' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(TOOL_NAME, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(TOOL_NAME, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(TOOL_NAME, request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizePainterInput(callResult.request.flags) };
  const decision = resolvePermissionDecision(TOOL_NAME, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(TOOL_NAME, decision),
      permissionDenials: [{ tool: TOOL_NAME, action: decision.action, reason: 'permission' }],
    };
  }
  const output = writePainterArtifact(request.flags);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(TOOL_NAME, request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock(TOOL_NAME, request.flags, toolUseID),
  };
}

function normalizePainterInput(input = {}) {
  const prompt = input.prompt ?? input.description ?? input.text ?? '';
  const output = input.output ?? input.path ?? input.file ?? 'coven-code-painter-output.png';
  const references = [input.reference, input.references, input.image, input.images]
    .flat()
    .filter(Boolean)
    .map(String);
  return {
    ...input,
    prompt: String(prompt),
    output: String(output),
    references,
  };
}

function writePainterArtifact(input) {
  const outputPath = path.resolve(process.cwd(), input.output);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, PAINTER_PLACEHOLDER_PNG);
  return [
    `Generated image: ${input.output}`,
    'media_type: image/png',
    `prompt: ${input.prompt}`,
    ...(input.references.length ? [`references: ${input.references.join(', ')}`] : []),
  ].join('\n');
}
