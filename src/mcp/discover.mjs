import { existsSync } from 'node:fs';
import path from 'node:path';
import { readManagedSettings, readSettings, readSettingsFile } from '../settings/load.mjs';
import { findWorkspaceSettingsFile } from '../settings/paths.mjs';
import {
  isMcpServerAllowed,
  mcpPermissionRules,
  mcpPermissionStatus,
  readWorkspaceMcpApprovals,
} from './permissions.mjs';
import { mcpRegistryGate, mcpRegistryStatus } from './registry.mjs';
import { listSkills } from '../skills/discover.mjs';

const MCP_SERVERS_SETTING = 'covenCode.mcpServers';

export function listConfiguredMcpServers(parsed = {}) {
  const { userSettings, workspaceSettings, managedSettings, approvals, permissionRules, registryGate } = mcpSettings(parsed);
  const byName = new Map();

  for (const [name, config] of Object.entries(userSettings[MCP_SERVERS_SETTING] ?? {})) {
    const expandedConfig = expandMcpServerConfigEnv(config);
    byName.set(name, {
      name,
      config: expandedConfig,
      source: 'user',
      status: mcpServerStatus('approved', expandedConfig, permissionRules, registryGate),
    });
  }
  for (const [name, config] of Object.entries(workspaceSettings[MCP_SERVERS_SETTING] ?? {})) {
    const expandedConfig = expandMcpServerConfigEnv(config);
    byName.set(name, {
      name,
      config: expandedConfig,
      source: 'workspace',
      status: mcpServerStatus(approvals[name] ? 'approved' : 'awaiting approval', expandedConfig, permissionRules, registryGate),
    });
  }
  for (const [name, config] of Object.entries(managedSettings[MCP_SERVERS_SETTING] ?? {})) {
    const expandedConfig = expandMcpServerConfigEnv(config);
    byName.set(name, {
      name,
      config: expandedConfig,
      source: 'managed',
      status: mcpServerStatus('approved', expandedConfig, permissionRules, registryGate),
    });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function listActiveMcpServerEntries(parsed = {}, prompt = '') {
  const { permissionRules, registryGate } = mcpSettings(parsed);
  const inline = parseInlineMcpServers(parsed.mcpConfig)
    .filter((server) => !isMcpServerDisabled(server.config))
    .filter((server) => !mcpRegistryStatus(server.config, registryGate))
    .filter((server) => isMcpServerAllowed(server.config, permissionRules))
    .map((server) => ({
      name: server.name,
      status: 'connected',
      source: 'cli',
      config: server.config,
    }));
  const inlineNames = new Set(inline.map((server) => server.name));
  const configured = listConfiguredMcpServers(parsed)
    .filter((server) => server.status === 'approved')
    .filter((server) => !inlineNames.has(server.name))
    .map((server) => ({ ...server, status: 'connected' }));
  const occupiedNames = new Set([...inline, ...configured].map((server) => server.name));
  const skillServers = listSkillMcpServers(prompt, parsed)
    .filter((server) => !isMcpServerDisabled(server.config))
    .filter((server) => !mcpRegistryStatus(server.config, registryGate))
    .filter((server) => isMcpServerAllowed(server.config, permissionRules))
    .filter((server) => !occupiedNames.has(server.name))
    .map((server) => ({ ...server, status: 'connected' }));
  return [...inline, ...configured, ...skillServers];
}

function mcpSettings(parsed = {}) {
  const userSettings = readSettings(parsed);
  const workspacePath = findWorkspaceSettingsFile(process.cwd());
  const workspaceSettings = workspacePath ? readSettingsFile(workspacePath) : {};
  const managedSettings = readManagedSettings();
  return {
    userSettings,
    workspaceSettings,
    managedSettings,
    approvals: readWorkspaceMcpApprovals(process.cwd()),
    permissionRules: mcpPermissionRules(userSettings, workspaceSettings, managedSettings),
    registryGate: mcpRegistryGate(userSettings, workspaceSettings, managedSettings),
  };
}

function mcpServerStatus(defaultStatus, config, permissionRules, registryGate) {
  if (isMcpServerDisabled(config)) return 'disabled';
  const registryStatus = mcpRegistryStatus(config, registryGate);
  if (registryStatus) return registryStatus;
  return mcpPermissionStatus(defaultStatus, config, permissionRules);
}

function isMcpServerDisabled(config = {}) {
  return config.disabled === true;
}

export function listActiveMcpServers(parsed = {}) {
  return listActiveMcpServerEntries(parsed).map(({ name, source }) => ({
    name,
    status: 'connected',
    source,
  }));
}

export function parseInlineMcpServers(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const servers = parsed.mcpServers ?? parsed[MCP_SERVERS_SETTING] ?? parsed;
    return Object.keys(servers).map((name) => ({ name, config: expandMcpServerConfigEnv(servers[name]) }));
  } catch {
    return [{ name: 'inline', config: { command: expandEnvVars(raw) } }];
  }
}

export function expandMcpServerConfigEnv(value) {
  if (typeof value === 'string') return expandEnvVars(value);
  if (Array.isArray(value)) return value.map((entry) => expandMcpServerConfigEnv(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandMcpServerConfigEnv(entry)]));
  }
  return value;
}

export function expandEnvVars(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? '');
}

export function formatMcpServerCommand(config) {
  if (config.url) return config.url;
  return [config.command, ...(config.args ?? [])].filter(Boolean).join(' ');
}

export function listSkillMcpServers(prompt = '', parsed = {}) {
  const lower = prompt.toLowerCase();
  const servers = [];
  for (const skill of listSkills({ parsed })) {
    if (!lower.includes(skill.name.toLowerCase())) continue;
    const mcpPath = path.join(skill.dir, 'mcp.json');
    if (!existsSync(mcpPath)) continue;
    const mcp = readSettingsFile(mcpPath);
    for (const [name, config] of Object.entries(mcp)) {
      servers.push({ name, config: expandMcpServerConfigEnv(config), source: `skill:${skill.name}` });
    }
  }
  return servers;
}
