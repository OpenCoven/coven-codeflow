import path from 'node:path';
import { resolvePermissionDecision } from '../../commands/permissions.mjs';
import { runPluginEventHandlers } from '../../plugins/discover.mjs';
import { globToRegex, walkFiles } from '../../util/glob.mjs';
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

export const TOOL_NAME = 'glob';

export async function executePromptGlobToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled(TOOL_NAME, 'built-in', parsed)) return { output: `Tool disabled: ${TOOL_NAME}` };
  request = { ...request, flags: normalizeGlobInput(request.flags) };
  if (!request.flags.pattern) return { output: 'glob requires --pattern' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(TOOL_NAME, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(TOOL_NAME, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(TOOL_NAME, request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeGlobInput(callResult.request.flags) };
  const decision = resolvePermissionDecision(TOOL_NAME, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(TOOL_NAME, decision),
      permissionDenials: [{ tool: TOOL_NAME, action: decision.action, reason: 'permission' }],
    };
  }
  const output = globBuiltinFiles(request.flags.pattern, request.flags.path);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(TOOL_NAME, request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock(TOOL_NAME, request.flags, toolUseID),
  };
}

function normalizeGlobInput(input = {}) {
  const pattern = input.pattern ?? input.glob ?? input.query;
  const searchPath = input.path ?? input.dir ?? input.cwd ?? '.';
  return {
    ...input,
    pattern: pattern ? String(pattern) : '',
    path: searchPath ? String(searchPath) : '.',
  };
}

function globBuiltinFiles(pattern, searchPath = '.') {
  const root = path.isAbsolute(searchPath) ? searchPath : path.resolve(process.cwd(), searchPath);
  const absolutePattern = path.isAbsolute(pattern) ? path.normalize(pattern) : path.normalize(path.join(root, pattern));
  const matchers = [globToRegex(absolutePattern)];
  if (!path.isAbsolute(pattern) && pattern.startsWith('**/')) {
    matchers.push(globToRegex(path.normalize(path.join(root, pattern.slice('**/'.length)))));
  }
  return walkFiles(root)
    .filter((filePath) => matchers.some((matcher) => matcher.test(path.normalize(filePath))))
    .map(relativeToolPath)
    .sort()
    .join('\n');
}
