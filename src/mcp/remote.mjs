import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMcpCallOutput, parseMcpResourceOutput } from './parsers.mjs';

const remoteMcpSessions = new Map();

export async function queryRemoteMcpTools(config = {}, serverName = '') {
  const message = await postRemoteMcp(config, 'tools/list', {}, serverName);
  if (Array.isArray(message.result?.tools)) return message.result.tools;
  if (Array.isArray(message.tools)) return message.tools;
  return [];
}

export async function callRemoteMcpTool(config = {}, name, args = {}, serverName = '') {
  const message = await postRemoteMcp(config, 'tools/call', { name, arguments: args }, serverName);
  return parseMcpCallOutput(`${JSON.stringify(message)}\n`);
}

export async function readRemoteMcpResource(config = {}, uri, serverName = '') {
  const message = await postRemoteMcp(config, 'resources/read', { uri }, serverName);
  return parseMcpResourceOutput(`${JSON.stringify(message)}\n`);
}

async function postRemoteMcp(config = {}, method, params, serverName = '') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  try {
    if (config.transport === 'sse') {
      return await postLegacySseMcp(config, body, controller.signal, serverName);
    }
    const response = await fetch(config.url, {
      method: 'POST',
      headers: remoteMcpHeaders(config, 'application/json, text/event-stream', serverName),
      body,
      signal: controller.signal,
    });
    rememberRemoteMcpSession(config, serverName, response);
    if (response.status === 400 && !remoteMcpSessions.has(remoteMcpSessionKey(config, serverName)) && await initializeRemoteMcpSession(config, serverName, controller.signal)) {
      const retry = await fetch(config.url, {
        method: 'POST',
        headers: remoteMcpHeaders(config, 'application/json, text/event-stream', serverName),
        body,
        signal: controller.signal,
      });
      rememberRemoteMcpSession(config, serverName, retry);
      return parseRemoteMcpResponse(await retry.text());
    }
    if (response.status === 401 && await refreshMcpOauthToken(serverName, config)) {
      const retry = await fetch(config.url, {
        method: 'POST',
        headers: remoteMcpHeaders(config, 'application/json, text/event-stream', serverName),
        body,
        signal: controller.signal,
      });
      rememberRemoteMcpSession(config, serverName, retry);
      return parseRemoteMcpResponse(await retry.text());
    }
    if (response.status >= 400 && response.status < 500) {
      return await postLegacySseMcp(config, body, controller.signal, serverName);
    }
    const text = await response.text();
    return parseRemoteMcpResponse(text);
  } catch {
    return {};
  } finally {
    clearTimeout(timeout);
  }
}

async function postLegacySseMcp(config = {}, body, signal, serverName = '') {
  const endpoint = await discoverLegacySseEndpoint(config, signal, serverName);
  if (!endpoint) return {};
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: remoteMcpHeaders(config, 'application/json, text/event-stream', serverName),
    body,
    signal,
  });
  rememberRemoteMcpSession(config, serverName, response);
  if (response.status === 401 && await refreshMcpOauthToken(serverName, config)) {
    const retry = await fetch(endpoint, {
      method: 'POST',
      headers: remoteMcpHeaders(config, 'application/json, text/event-stream', serverName),
      body,
      signal,
    });
    rememberRemoteMcpSession(config, serverName, retry);
    return parseRemoteMcpResponse(await retry.text());
  }
  return parseRemoteMcpResponse(await response.text());
}

async function discoverLegacySseEndpoint(config = {}, signal, serverName = '') {
  const response = await fetch(config.url, {
    method: 'GET',
    headers: remoteMcpHeaders(config, 'text/event-stream', serverName),
    signal,
  });
  if (!response.ok) return '';
  return resolveRemoteMcpUrl(config.url, parseLegacySseEndpoint(await response.text()));
}

function remoteMcpHeaders(config = {}, accept, serverName = '') {
  return {
    'content-type': 'application/json',
    accept,
    ...oauthMcpHeaders(serverName),
    ...remoteMcpSessionHeader(config, serverName),
    ...(config.headers ?? {}),
  };
}

async function initializeRemoteMcpSession(config = {}, serverName = '', signal) {
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

function rememberRemoteMcpSession(config = {}, serverName = '', response) {
  const sessionId = response.headers.get('mcp-session-id');
  if (sessionId) remoteMcpSessions.set(remoteMcpSessionKey(config, serverName), sessionId);
}

function remoteMcpSessionHeader(config = {}, serverName = '') {
  const sessionId = remoteMcpSessions.get(remoteMcpSessionKey(config, serverName));
  return sessionId ? { 'Mcp-Session-Id': sessionId } : {};
}

function remoteMcpSessionKey(config = {}, serverName = '') {
  return `${serverName}\n${config.url ?? ''}`;
}

function oauthMcpHeaders(serverName = '') {
  const credential = readMcpOauthCredential(serverName);
  return credential.accessToken || credential.access_token ? { Authorization: `Bearer ${credential.accessToken ?? credential.access_token}` } : {};
}

function readMcpOauthCredential(serverName = '') {
  if (!serverName) return {};
  try {
    return JSON.parse(readFileSync(mcpOauthCredentialPath(serverName), 'utf8'));
  } catch {
    return {};
  }
}

async function refreshMcpOauthToken(serverName = '', config = {}) {
  if (hasExplicitAuthorizationHeader(config)) return false;
  const credential = readMcpOauthCredential(serverName);
  const refreshToken = credential.refreshToken ?? credential.refresh_token;
  const tokenUrl = credential.tokenUrl ?? credential.token_url;
  if (!refreshToken || !tokenUrl) return false;
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      ...(credential.clientId || credential.client_id ? { client_id: credential.clientId ?? credential.client_id } : {}),
      ...(credential.clientSecret || credential.client_secret ? { client_secret: credential.clientSecret ?? credential.client_secret } : {}),
    }),
  });
  if (!response.ok) return false;
  const token = await response.json();
  const nextCredential = {
    ...credential,
    accessToken: token.access_token ?? token.accessToken ?? credential.accessToken,
    refreshToken: token.refresh_token ?? token.refreshToken ?? credential.refreshToken,
    ...(token.expires_in || token.expiresIn ? { expiresAt: Date.now() + Number(token.expires_in ?? token.expiresIn) * 1000 } : {}),
  };
  const credentialPath = mcpOauthCredentialPath(serverName);
  mkdirSync(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
  writeFileSync(credentialPath, `${JSON.stringify(nextCredential, null, 2)}\n`, { mode: 0o600 });
  return Boolean(nextCredential.accessToken);
}

function hasExplicitAuthorizationHeader(config = {}) {
  return Object.keys(config.headers ?? {}).some((key) => key.toLowerCase() === 'authorization');
}

function mcpOauthCredentialPath(serverName) {
  return path.join(os.homedir(), '.coven-code', 'oauth', `${serverName}.json`);
}

function parseLegacySseEndpoint(text = '') {
  let event = 'message';
  const data = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) {
      if (event === 'endpoint' && data.length) return data.join('\n').trim();
      event = 'message';
      data.length = 0;
      continue;
    }
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  if (event === 'endpoint' && data.length) return data.join('\n').trim();
  return '';
}

function resolveRemoteMcpUrl(base, endpoint) {
  if (!endpoint) return '';
  try {
    return new URL(endpoint, base).href;
  } catch {
    return '';
  }
}

function parseRemoteMcpResponse(text = '') {
  for (const chunk of text.split(/\r?\n/).filter(Boolean)) {
    const line = chunk.startsWith('data:') ? chunk.slice('data:'.length).trim() : chunk.trim();
    if (!line || line === '[DONE]') continue;
    try {
      return JSON.parse(line);
    } catch {
      // Remote MCP servers can include diagnostic or event wrapper lines.
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
