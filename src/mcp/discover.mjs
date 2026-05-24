import { existsSync } from 'node:fs';
import path from 'node:path';
import { readManagedSettings, readSettings, readSettingsFile } from '../settings/load.mjs';
import { findWorkspaceSettingsFile } from '../settings/paths.mjs';
import {
  isMcpServerAllowed,
  mcpPermissionRules,
  mcpPermissionRulesForCwd,
  mcpPermissionStatus,
  readWorkspaceMcpApprovals,
} from './permissions.mjs';
import { listSkills } from '../skills/discover.mjs';

export function listConfiguredMcpServers(parsed = {}) {
  const userSettings = readSettings(parsed);
  const workspacePath = findWorkspaceSettingsFile(process.cwd());
  const workspaceSettings = workspacePath ? readSettingsFile(workspacePath) : {};
  const managedSettings = readManagedSettings();
  const approvals = readWorkspaceMcpApprovals(process.cwd());
  const permissionRules = mcpPermissionRules(userSettings, workspaceSettings, managedSettings);
  const byName = new Map();

  for (const [name, config] of Object.entries(userSettings['amp.mcpServers'] ?? {})) {
    const expandedConfig = expandMcpServerConfigEnv(config);
    byName.set(name, {
      name,
      config: expandedConfig,
      source: 'user',
      status: mcpPermissionStatus('approved', expandedConfig, permissionRules),
    });
  }
  for (const [name, config] of Object.entries(workspaceSettings['amp.mcpServers'] ?? {})) {
    const expandedConfig = expandMcpServerConfigEnv(config);
    byName.set(name, {
      name,
      config: expandedConfig,
      source: 'workspace',
      status: mcpPermissionStatus(approvals[name] ? 'approved' : 'awaiting approval', expandedConfig, permissionRules),
    });
  }
  for (const [name, config] of Object.entries(managedSettings['amp.mcpServers'] ?? {})) {
    const expandedConfig = expandMcpServerConfigEnv(config);
    byName.set(name, {
      name,
      config: expandedConfig,
      source: 'managed',
      status: mcpPermissionStatus('approved', expandedConfig, permissionRules),
    });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function listActiveMcpServerEntries(parsed = {}, prompt = '') {
  const permissionRules = mcpPermissionRulesForCwd(parsed);
  const inline = parseInlineMcpServers(parsed.mcpConfig)
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
  const skillServers = listSkillMcpServers(prompt)
    .filter((server) => isMcpServerAllowed(server.config, permissionRules))
    .filter((server) => !occupiedNames.has(server.name))
    .map((server) => ({ ...server, status: 'connected' }));
  return [...inline, ...configured, ...skillServers];
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
    const servers = parsed.mcpServers ?? parsed['amp.mcpServers'] ?? parsed;
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

export function listSkillMcpServers(prompt = '') {
  const lower = prompt.toLowerCase();
  const servers = [];
  for (const skill of listSkills()) {
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
