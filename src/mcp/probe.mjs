import { spawnSync } from 'node:child_process';
import { globMatch } from '../util/glob.mjs';

export function discoverMcpToolRows(servers) {
  const rows = [];
  for (const server of servers) {
    const toolDefs = filterIncludedMcpTools(
      server.config,
      server.source?.startsWith('skill:')
        ? skillMcpTools(server.config)
        : queryLocalMcpTools(server.config),
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

function filterIncludedMcpTools(config = {}, tools = []) {
  if (!Array.isArray(config.includeTools) || config.includeTools.length === 0) return tools;
  return tools.filter((tool) => config.includeTools.some((pattern) => globMatch(pattern, tool.name)));
}

function queryLocalMcpTools(config = {}) {
  if (!config.command) return [];
  const result = spawnSync(config.command, config.args ?? [], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`,
    env: { ...process.env, ...(config.env ?? {}) },
    encoding: 'utf8',
    timeout: 1500,
  });
  return parseMcpToolsOutput(result.stdout);
}

export function callLocalMcpTool(config = {}, name, args = {}) {
  if (!config.command) return '';
  const result = spawnSync(config.command, config.args ?? [], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`,
    env: { ...process.env, ...(config.env ?? {}) },
    encoding: 'utf8',
    timeout: 1500,
  });
  return parseMcpCallOutput(result.stdout);
}

function parseMcpCallOutput(stdout = '') {
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const message = JSON.parse(line);
      const content = message.result?.content ?? message.content;
      if (Array.isArray(content)) {
        return content.map((entry) => entry.text ?? entry.content ?? JSON.stringify(entry)).join('\n');
      }
      if (typeof content === 'string') return content;
      if (message.result !== undefined) return JSON.stringify(message.result);
    } catch {
      // Non-JSON diagnostic output from MCP server startup is ignored.
    }
  }
  return '';
}

function parseMcpToolsOutput(stdout = '') {
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const message = JSON.parse(line);
      if (Array.isArray(message.result?.tools)) return message.result.tools;
      if (Array.isArray(message.tools)) return message.tools;
    } catch {
      // Non-JSON diagnostic output from MCP server startup is ignored.
    }
  }
  return [];
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
