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
  toolCallDecisionToolRun,
  validateToolCallDecision,
} from './runtime.mjs';

export const TOOL_NAME = 'librarian';

export async function executePromptLibrarianToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled(TOOL_NAME, 'built-in', parsed)) return { output: `Tool disabled: ${TOOL_NAME}` };
  request = { ...request, flags: normalizeLibrarianInput(request.flags) };
  if (!request.flags.query) return { output: 'librarian requires --query' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(TOOL_NAME, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(TOOL_NAME, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(TOOL_NAME, request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeLibrarianInput(callResult.request.flags) };
  const decision = resolvePermissionDecision(TOOL_NAME, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(TOOL_NAME, decision),
      permissionDenials: [{ tool: TOOL_NAME, action: decision.action, reason: 'permission' }],
    };
  }
  const output = searchWorkspaceForLibrarian(request.flags);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(TOOL_NAME, request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock(TOOL_NAME, request.flags, toolUseID),
  };
}

function normalizeLibrarianInput(input = {}) {
  const query = input.query ?? input.q ?? input.prompt ?? input.question ?? input.topic;
  const limit = Number.parseInt(String(input.limit ?? 5), 10);
  return {
    ...input,
    query: query ? String(query) : '',
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 20) : 5,
  };
}

function searchWorkspaceForLibrarian(input) {
  const matches = findWorkspaceTextMatches(input.query, input.limit);
  return [
    `Librarian search: ${input.query}`,
    'scope: current workspace',
    'matches:',
    ...(matches.length ? matches.map(formatLibrarianMatch) : ['- no local matches found']),
  ].join('\n');
}

function findWorkspaceTextMatches(query, limit) {
  const needle = query.toLowerCase();
  const root = process.cwd();
  return walkFiles(root)
    .map((filePath) => path.relative(root, filePath))
    .filter((relativePath) => !relativePath.split(path.sep).some((part) => part === '.git' || part === 'node_modules'))
    .sort()
    .flatMap((relativePath) => {
      let text;
      try {
        text = readFileSync(path.join(root, relativePath), 'utf8');
      } catch {
        return [];
      }
      return text.split(/\r?\n/).flatMap((line, index) => (
        line.toLowerCase().includes(needle)
          ? [{ path: relativePath, line: index + 1, text: line.trim() }]
          : []
      ));
    })
    .slice(0, limit);
}

function formatLibrarianMatch(match) {
  return `- ${match.path}:${match.line}: ${match.text}`;
}
