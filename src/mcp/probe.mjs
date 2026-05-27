import { globMatch } from '../util/glob.mjs';
import {
  callLocalMcpTool,
  queryLocalMcpTools,
  queryLocalMcpToolsResult,
  readLocalMcpResource,
} from './local.mjs';
import { parseMcpToolsOutput } from './parsers.mjs';
import {
  callRemoteMcpTool,
  queryRemoteMcpTools,
  readRemoteMcpResource,
} from './remote.mjs';

export async function discoverMcpToolRows(servers) {
  const rows = [];
  for (const server of servers) {
    const toolDefs = filterIncludedMcpTools(
      server.config,
      server.source?.startsWith('skill:')
        ? skillMcpTools(server.config)
        : await queryMcpTools(server.config, server.name),
    );
    for (const tool of toolDefs) {
      rows.push([
        `mcp__${server.name}__${tool.name}`,
        'local-mcp',
        tool.description || `Tool from ${server.name}`,
      ]);
    }
  }
  return rows;
}

export async function mcpServerHealth(config = {}, serverName = '') {
  if (config.url) {
    const tools = await queryRemoteMcpTools(config, serverName);
    return formatToolHealth(tools);
  }
  const result = queryLocalMcpToolsResult(config);
  if (result.error) return `error ${result.error.code ?? result.error.message}`;
  if ((result.status ?? 0) !== 0) return `error exit ${result.status}`;
  return formatToolHealth(parseMcpToolsOutput(result.stdout));
}

function formatToolHealth(tools = []) {
  return `ok ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`;
}

function filterIncludedMcpTools(config = {}, tools = []) {
  return tools.filter((tool) => isMcpToolIncluded(config, tool.name));
}

export function isMcpToolIncluded(config = {}, toolName = '') {
  if (!Array.isArray(config.includeTools) || config.includeTools.length === 0) return true;
  return config.includeTools.some((pattern) => globMatch(pattern, toolName));
}

async function queryMcpTools(config = {}, serverName = '') {
  if (config.url) return queryRemoteMcpTools(config, serverName);
  return queryLocalMcpTools(config);
}

export async function callMcpTool(config = {}, name, args = {}, serverName = '') {
  if (config.url) return callRemoteMcpTool(config, name, args, serverName);
  return callLocalMcpTool(config, name, args);
}

export async function readMcpResource(config = {}, uri, serverName = '') {
  if (config.url) return readRemoteMcpResource(config, uri, serverName);
  return readLocalMcpResource(config, uri);
}

export function skillMcpTools(config = {}) {
  return (config.includeTools ?? []).map((name) => ({
    name,
    description: `Tool from skill MCP server ${config.command || config.url || ''}`.trim(),
  }));
}

export function parseMcpToolName(name) {
  const match = name.match(/^mcp__([^_]+(?:_[^_]+)*)__([\s\S]+)$/);
  if (!match) return undefined;
  return { serverName: match[1], toolName: match[2] };
}
