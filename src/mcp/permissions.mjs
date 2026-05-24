import path from 'node:path';
import { findWorkspaceSettingsFile, workspaceSettingsFile } from '../settings/paths.mjs';
import { readManagedSettings, readSettings, readSettingsFile, writeSettingsFile } from '../settings/load.mjs';
import { globMatch } from '../util/glob.mjs';

export function mcpPermissionRulesForCwd(parsed = {}) {
  const userSettings = readSettings(parsed);
  const workspacePath = findWorkspaceSettingsFile(process.cwd());
  const workspaceSettings = workspacePath ? readSettingsFile(workspacePath) : {};
  return mcpPermissionRules(userSettings, workspaceSettings, readManagedSettings());
}

export function mcpPermissionRules(userSettings = {}, workspaceSettings = {}, managedSettings = {}) {
  if (Array.isArray(managedSettings['amp.mcpPermissions'])) return managedSettings['amp.mcpPermissions'];
  if (Array.isArray(workspaceSettings['amp.mcpPermissions'])) return workspaceSettings['amp.mcpPermissions'];
  if (Array.isArray(userSettings['amp.mcpPermissions'])) return userSettings['amp.mcpPermissions'];
  return [];
}

export function mcpPermissionStatus(defaultStatus, config, rules) {
  return isMcpServerAllowed(config, rules) ? defaultStatus : 'rejected';
}

export function isMcpServerAllowed(config = {}, rules = []) {
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || !rule.matches || typeof rule.matches !== 'object') continue;
    if (!mcpPermissionRuleMatches(config, rule.matches)) continue;
    return rule.action !== 'reject';
  }
  return true;
}

function mcpPermissionRuleMatches(config = {}, matches = {}) {
  const entries = Object.entries(matches);
  if (entries.length === 0) return false;
  return entries.every(([field, pattern]) => {
    if (field === 'command') return globMatch(pattern, config.command ?? '');
    if (field === 'args') return globMatch(pattern, (config.args ?? []).join(' '));
    if (field === 'url') return globMatch(pattern, config.url ?? '');
    return false;
  });
}

export function readWorkspaceMcpApprovals(cwd) {
  return readSettingsFile(path.join(path.dirname(workspaceSettingsFile(cwd)), 'mcp-approvals.json'));
}

export async function writeWorkspaceMcpApprovals(cwd, approvals) {
  await writeSettingsFile(path.join(path.dirname(workspaceSettingsFile(cwd)), 'mcp-approvals.json'), approvals);
}
