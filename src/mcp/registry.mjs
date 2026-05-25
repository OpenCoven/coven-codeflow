import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MCP_REGISTRY_SETTING = 'covenCode.mcpRegistry';
const MCP_REGISTRY_URL_SETTING = 'covenCode.mcpRegistry.url';

export function mcpRegistryGate(userSettings = {}, workspaceSettings = {}, managedSettings = {}) {
  const policy = registryPolicy(managedSettings) ?? registryPolicy(workspaceSettings) ?? registryPolicy(userSettings);
  if (!policy?.url) return { enabled: false };
  const payload = registryPayload(policy.url);
  if (!payload) return { enabled: true, reachable: false, allowedNames: new Set(), allowedUrls: new Set() };
  try {
    return { enabled: true, reachable: true, ...registryAllowlist(JSON.parse(payload)) };
  } catch {
    return { enabled: true, reachable: false, allowedNames: new Set(), allowedUrls: new Set() };
  }
}

export function mcpRegistryStatus(config = {}, gate = { enabled: false }) {
  if (!gate.enabled) return undefined;
  if (!gate.reachable) return 'registry-blocked';
  return registryAllowsConfig(config, gate) ? undefined : 'registry-blocked';
}

function registryPolicy(settings = {}) {
  const value = settings[MCP_REGISTRY_SETTING];
  if (typeof value === 'string' && value.trim()) return { url: value.trim() };
  if (value && typeof value === 'object' && typeof value.url === 'string' && value.url.trim()) {
    return { url: value.url.trim() };
  }
  const url = settings[MCP_REGISTRY_URL_SETTING];
  if (typeof url === 'string' && url.trim()) return { url: url.trim() };
  return undefined;
}

function registryPayload(url) {
  try {
    if (/^https?:\/\//i.test(url)) return fetchRegistryUrlSync(url);
    if (url.startsWith('file://')) return readFileSync(fileURLToPath(url), 'utf8');
    return readFileSync(url, 'utf8');
  } catch {
    return undefined;
  }
}

function fetchRegistryUrlSync(url) {
  const script = `
const url = process.env.COVEN_CODE_MCP_REGISTRY_URL;
const timeout = AbortSignal.timeout(1500);
try {
  const response = await fetch(url, { signal: timeout });
  if (!response.ok) process.exit(2);
  process.stdout.write(await response.text());
} catch {
  process.exit(1);
}
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, COVEN_CODE_MCP_REGISTRY_URL: url },
    encoding: 'utf8',
    timeout: 2500,
  });
  return result.status === 0 ? result.stdout : undefined;
}

function registryAllowlist(payload) {
  const allowedNames = new Set();
  const allowedUrls = new Set();
  const entries = Array.isArray(payload?.servers) ? payload.servers : Array.isArray(payload) ? payload : [];
  for (const entry of entries) {
    const server = entry?.server ?? entry;
    if (!server || typeof server !== 'object') continue;
    if (typeof server.name === 'string') allowedNames.add(server.name);
    for (const remote of Array.isArray(server.remotes) ? server.remotes : []) {
      if (typeof remote?.url === 'string') allowedUrls.add(normalizeRegistryUrl(remote.url));
    }
  }
  return { allowedNames, allowedUrls };
}

function registryAllowsConfig(config = {}, gate = {}) {
  if (typeof config.registryName === 'string' && gate.allowedNames?.has(config.registryName)) return true;
  if (typeof config.url === 'string' && gate.allowedUrls?.has(normalizeRegistryUrl(config.url))) return true;
  return false;
}

function normalizeRegistryUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return String(value).replace(/\/$/, '');
  }
}
