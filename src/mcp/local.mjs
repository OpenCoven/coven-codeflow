import { spawnSync } from 'node:child_process';
import { parseMcpCallOutput, parseMcpResourceOutput, parseMcpToolsOutput } from './parsers.mjs';

export function queryLocalMcpTools(config = {}) {
  return parseMcpToolsOutput(queryLocalMcpToolsResult(config).stdout ?? '');
}

export function queryLocalMcpToolsResult(config = {}) {
  if (!config.command) return [];
  return spawnSync(config.command, config.args ?? [], {
    input: localMcpRequestInput('tools/list', {}),
    env: { ...process.env, ...(config.env ?? {}) },
    encoding: 'utf8',
    timeout: 1500,
  });
}

export function callLocalMcpTool(config = {}, name, args = {}) {
  if (!config.command) return '';
  const result = spawnSync(config.command, config.args ?? [], {
    input: localMcpRequestInput('tools/call', { name, arguments: args }),
    env: { ...process.env, ...(config.env ?? {}) },
    encoding: 'utf8',
    timeout: 1500,
  });
  return parseMcpCallOutput(result.stdout);
}

export function readLocalMcpResource(config = {}, uri) {
  if (!config.command) return '';
  const result = spawnSync(config.command, config.args ?? [], {
    input: localMcpRequestInput('resources/read', { uri }),
    env: { ...process.env, ...(config.env ?? {}) },
    encoding: 'utf8',
    timeout: 1500,
  });
  return parseMcpResourceOutput(result.stdout);
}

function localMcpRequestInput(method, params = {}) {
  return [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'coven-code', version: '0.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method, params },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';
}
