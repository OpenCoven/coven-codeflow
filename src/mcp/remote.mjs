import { parseMcpCallOutput, parseMcpResourceOutput } from './parsers.mjs';
import { refreshMcpOauthToken } from './remote-oauth.mjs';
import {
  initializeRemoteMcpSession,
  rememberRemoteMcpSession,
  remoteMcpHeaders,
  remoteMcpSessionKey,
  remoteMcpSessions,
} from './remote-session.mjs';
import { parseRemoteMcpResponse, postLegacySseMcp } from './remote-sse.mjs';

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
