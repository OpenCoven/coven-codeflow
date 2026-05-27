import { resolvePermissionDecision } from '../../commands/permissions.mjs';
import { runPluginEventHandlers } from '../../plugins/discover.mjs';
import { decodeHtmlText } from '../../util/html.mjs';
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

export const TOOL_NAME = 'web_search';

export async function executePromptWebSearchToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled(TOOL_NAME, 'built-in', parsed)) return { output: `Tool disabled: ${TOOL_NAME}` };
  request = { ...request, flags: normalizeWebSearchInput(request.flags) };
  if (!request.flags.query) return { output: 'web_search requires --query' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(TOOL_NAME, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(TOOL_NAME, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(TOOL_NAME, request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeWebSearchInput(callResult.request.flags) };
  const decision = resolvePermissionDecision(TOOL_NAME, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(TOOL_NAME, decision),
      permissionDenials: [{ tool: TOOL_NAME, action: decision.action, reason: 'permission' }],
    };
  }
  const output = await searchWebBuiltin(request.flags.query, request.flags.limit);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(TOOL_NAME, request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock(TOOL_NAME, request.flags, toolUseID),
  };
}

function normalizeWebSearchInput(input = {}) {
  const query = input.query ?? input.q ?? input.search;
  const limit = Number.parseInt(String(input.limit ?? input.count ?? 5), 10);
  return {
    ...input,
    query: query ? String(query) : '',
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 10) : 5,
  };
}

async function searchWebBuiltin(query, limit = 5) {
  const fixture = webSearchFixtureResults(limit);
  if (fixture) return formatWebSearchResults(fixture, query);

  try {
    const url = `https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query }).toString()}`;
    const response = await fetch(url, {
      headers: { 'user-agent': 'coven-code/0.0.0' },
    });
    if (!response.ok) return `Web search failed for ${query}: HTTP ${response.status}`;
    const results = parseDuckDuckGoHtml(await response.text()).slice(0, limit);
    return formatWebSearchResults(results, query);
  } catch (error) {
    return `Web search failed for ${query}: ${error.message}`;
  }
}

function webSearchFixtureResults(limit) {
  const fixtureJson = process.env.COVEN_CODE_WEB_SEARCH_RESULTS_JSON;
  if (!fixtureJson) return undefined;
  try {
    const parsed = JSON.parse(fixtureJson);
    return Array.isArray(parsed) ? parsed.slice(0, limit) : [];
  } catch {
    return [];
  }
}

function parseDuckDuckGoHtml(html) {
  const blocks = html.match(/<div[^>]+class="[^"]*result[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*result[^"]*"|<\/body>)/g) ?? [];
  return blocks
    .map((block) => {
      const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!link) return undefined;
      const snippet = block.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/)
        ?? block.match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      return {
        title: cleanHtmlText(link[2]),
        url: cleanDuckDuckGoUrl(decodeHtmlText(link[1])),
        snippet: snippet ? cleanHtmlText(snippet[1]) : '',
      };
    })
    .filter(Boolean);
}

function cleanDuckDuckGoUrl(url) {
  try {
    const parsed = new URL(url);
    const redirected = parsed.searchParams.get('uddg');
    return redirected ? decodeURIComponent(redirected) : url;
  } catch {
    return url;
  }
}

function cleanHtmlText(value = '') {
  return decodeHtmlText(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function formatWebSearchResults(results = [], query = '') {
  if (results.length === 0) return `No web search results found for ${query}`;
  return results
    .map((result, index) => [
      `${index + 1}. ${result.title ?? 'Untitled'}`,
      result.url ?? '',
      result.snippet ?? '',
    ].filter(Boolean).join('\n'))
    .join('\n\n');
}
