import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolvePermissionDecision } from '../../commands/permissions.mjs';
import { runPluginEventHandlers } from '../../plugins/discover.mjs';
import { walkFiles } from '../../util/glob.mjs';
import { isToolDisabled } from '../toolbox.mjs';
import {
  applyToolCallDecision,
  createToolUseID,
  permissionDeniedOutput,
  pluginTextToolRunResult,
  pluginToolCallEvent,
  pluginToolResultEvent,
  pluginToolUseBlock,
  relativeToolPath,
  toolCallDecisionToolRun,
  validateToolCallDecision,
} from './runtime.mjs';

export const TOOL_NAME = 'Grep';

export async function executePromptGrepToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled(TOOL_NAME, 'built-in', parsed)) return { output: `Tool disabled: ${TOOL_NAME}` };
  request = { ...request, flags: normalizeGrepInput(request.flags) };
  if (!request.flags.pattern) return { output: 'Grep requires --pattern' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(TOOL_NAME, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(TOOL_NAME, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(TOOL_NAME, request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeGrepInput(callResult.request.flags) };
  const decision = resolvePermissionDecision(TOOL_NAME, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(TOOL_NAME, decision),
      permissionDenials: [{ tool: TOOL_NAME, action: decision.action, reason: 'permission' }],
    };
  }
  const output = grepBuiltinFiles(request.flags.pattern, request.flags.path);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(TOOL_NAME, request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock(TOOL_NAME, request.flags, toolUseID),
  };
}

function normalizeGrepInput(input = {}) {
  const pattern = input.pattern ?? input.regex ?? input.query;
  const searchPath = input.path ?? input.dir ?? input.cwd ?? '.';
  return {
    ...input,
    pattern: pattern ? String(pattern) : '',
    path: searchPath ? String(searchPath) : '.',
  };
}

function grepBuiltinFiles(pattern, searchPath = '.') {
  const root = path.isAbsolute(searchPath) ? searchPath : path.resolve(process.cwd(), searchPath);
  const files = walkFiles(root).sort();
  const re = new RegExp(pattern);
  const matches = [];
  for (const filePath of files) {
    let content = '';
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!re.test(lines[index])) continue;
      matches.push(`${relativeToolPath(filePath)}:${index + 1}:${lines[index]}`);
    }
  }
  return matches.join('\n');
}
