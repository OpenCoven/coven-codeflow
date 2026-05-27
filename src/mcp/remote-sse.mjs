import { refreshMcpOauthToken } from './remote-oauth.mjs';
import { rememberRemoteMcpSession, remoteMcpHeaders } from './remote-session.mjs';

export async function postLegacySseMcp(config = {}, body, signal, serverName = '') {
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

export function parseRemoteMcpResponse(text = '') {
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
