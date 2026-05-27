import { oauthMcpHeaders } from './remote-oauth.mjs';

export const remoteMcpSessions = new Map();

export function remoteMcpHeaders(config = {}, accept, serverName = '') {
  return {
    'content-type': 'application/json',
    accept,
    ...oauthMcpHeaders(serverName),
    ...remoteMcpSessionHeader(config, serverName),
    ...(config.headers ?? {}),
  };
}

export async function initializeRemoteMcpSession(config = {}, serverName = '', signal) {
  const response = await fetch(config.url, {
    method: 'POST',
    headers: remoteMcpHeaders(config, 'application/json, text/event-stream', serverName),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'coven-code', version: '0.0.0' },
      },
    }),
    signal,
  });
  rememberRemoteMcpSession(config, serverName, response);
  if (!response.ok || !remoteMcpSessions.has(remoteMcpSessionKey(config, serverName))) return false;
  await fetch(config.url, {
    method: 'POST',
    headers: remoteMcpHeaders(config, 'application/json, text/event-stream', serverName),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal,
  });
  return true;
}

export function rememberRemoteMcpSession(config = {}, serverName = '', response) {
  const sessionId = response.headers.get('mcp-session-id');
  if (sessionId) remoteMcpSessions.set(remoteMcpSessionKey(config, serverName), sessionId);
}

function remoteMcpSessionHeader(config = {}, serverName = '') {
  const sessionId = remoteMcpSessions.get(remoteMcpSessionKey(config, serverName));
  return sessionId ? { 'Mcp-Session-Id': sessionId } : {};
}

export function remoteMcpSessionKey(config = {}, serverName = '') {
  return `${serverName}\n${config.url ?? ''}`;
}
