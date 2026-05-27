import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function oauthMcpHeaders(serverName = '') {
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

export async function refreshMcpOauthToken(serverName = '', config = {}) {
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
