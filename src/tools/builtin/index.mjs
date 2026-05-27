import { loadPlugins } from '../../plugins/discover.mjs';
import { parseToolUseArgs } from '../toolbox.mjs';
import { splitShellWords } from '../../util/shell.mjs';
import { executePromptBashToolRequest } from './bash.mjs';
import { executePromptCreateFileToolRequest } from './create-file.mjs';
import { executePromptEditFileToolRequest } from './edit-file.mjs';
import { executePromptFinderToolRequest } from './finder.mjs';
import { executePromptGlobToolRequest } from './glob.mjs';
import { executePromptGrepToolRequest } from './grep.mjs';
import { executePromptLibrarianToolRequest } from './librarian.mjs';
import { executePromptLookAtToolRequest } from './look-at.mjs';
import { executePromptMcpToolRequest } from './mcp.mjs';
import { executePromptMermaidToolRequest } from './mermaid.mjs';
import { executePromptOracleToolRequest } from './oracle.mjs';
import { executePromptPainterToolRequest } from './painter.mjs';
import { executePromptPluginToolRequest } from './plugin-tool.mjs';
import { executePromptReadMcpResourceToolRequest } from './read-mcp-resource.mjs';
import { executePromptReadToolRequest } from './read.mjs';
import { executePromptReadWebPageToolRequest } from './read-web-page.mjs';
import { executePromptTaskToolRequest } from './task.mjs';
import { executePromptToolboxToolRequest } from './toolbox-tool.mjs';
import { executePromptUndoEditToolRequest } from './undo-edit.mjs';
import { executePromptWebSearchToolRequest } from './web-search.mjs';

const BUILTIN_DISPATCH = new Map([
  ['Bash', (request, stdin, parsed, plugins, threadId) =>
    executePromptBashToolRequest(request, stdin, parsed, plugins, threadId)],
  ['Read', (request, _stdin, parsed, plugins, threadId) =>
    executePromptReadToolRequest(request, parsed, plugins, threadId)],
  ['Grep', (request, _stdin, parsed, plugins, threadId) =>
    executePromptGrepToolRequest(request, parsed, plugins, threadId)],
  ['glob', (request, _stdin, parsed, plugins, threadId) =>
    executePromptGlobToolRequest(request, parsed, plugins, threadId)],
  ['create_file', (request, _stdin, parsed, plugins, threadId) =>
    executePromptCreateFileToolRequest(request, parsed, plugins, threadId)],
  ['edit_file', (request, _stdin, parsed, plugins, threadId) =>
    executePromptEditFileToolRequest(request, parsed, plugins, threadId)],
  ['undo_edit', (request, _stdin, parsed, plugins, threadId) =>
    executePromptUndoEditToolRequest(request, parsed, plugins, threadId)],
  ['Task', (request, _stdin, parsed, plugins, threadId) =>
    executePromptTaskToolRequest(request, parsed, plugins, threadId)],
  ['oracle', (request, _stdin, parsed, plugins, threadId) =>
    executePromptOracleToolRequest(request, parsed, plugins, threadId)],
  ['librarian', (request, _stdin, parsed, plugins, threadId) =>
    executePromptLibrarianToolRequest(request, parsed, plugins, threadId)],
  ['painter', (request, _stdin, parsed, plugins, threadId) =>
    executePromptPainterToolRequest(request, parsed, plugins, threadId)],
  ['mermaid', (request, _stdin, parsed, plugins, threadId) =>
    executePromptMermaidToolRequest(request, parsed, plugins, threadId)],
  ['look_at', (request, _stdin, parsed, plugins, threadId) =>
    executePromptLookAtToolRequest(request, parsed, plugins, threadId)],
  ['web_search', (request, _stdin, parsed, plugins, threadId) =>
    executePromptWebSearchToolRequest(request, parsed, plugins, threadId)],
  ['read_web_page', (request, _stdin, parsed, plugins, threadId) =>
    executePromptReadWebPageToolRequest(request, parsed, plugins, threadId)],
  ['find_thread', (request, _stdin, parsed, plugins, threadId) =>
    executePromptFinderToolRequest(request, parsed, plugins, threadId, 'find_thread')],
  ['finder', (request, _stdin, parsed, plugins, threadId) =>
    executePromptFinderToolRequest(request, parsed, plugins, threadId)],
  ['read_mcp_resource', (request, _stdin, parsed, plugins, threadId) =>
    executePromptReadMcpResourceToolRequest(request, parsed, plugins, threadId)],
]);

export async function executePromptToolRequest(prompt, stdin, threadId, parsed = {}) {
  const request = parsePromptToolRequest(prompt);
  if (!request) return undefined;
  const plugins = await loadPlugins(process.cwd());
  if (request.toolName.startsWith('mcp__')) {
    return executePromptMcpToolRequest(request, parsed, threadId, plugins);
  }
  const builtin = BUILTIN_DISPATCH.get(request.toolName);
  if (builtin) return builtin(request, stdin, parsed, plugins, threadId);
  const pluginTool = plugins.tools.find((entry) => entry.name === request.toolName);
  if (pluginTool) return executePromptPluginToolRequest(pluginTool, request, parsed, plugins, threadId);
  return executePromptToolboxToolRequest(request, stdin, parsed, plugins, threadId);
}

export function parsePromptToolRequest(prompt) {
  const match = prompt.match(/\b(?:use|run|call)\s+([A-Za-z0-9_-]+(?:__[A-Za-z0-9_-]+)?)([^\r\n]*)/i);
  if (!match) return undefined;
  const useArgs = parseToolUseArgs([match[1], ...splitShellWords(match[2] ?? '')]);
  return { toolName: useArgs.toolName, flags: useArgs.flags };
}
