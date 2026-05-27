import { BUILTIN_PERMISSIONS } from '../constants.mjs';
import { readEffectiveSettings } from '../settings/load.mjs';

export const PERMISSIONS_SETTING = 'covenCode.permissions';
export const COMMAND_ALLOWLIST_SETTING = 'covenCode.commands.allowlist';
export const DANGEROUSLY_ALLOW_ALL_SETTING = 'covenCode.dangerouslyAllowAll';
export const GUARDED_FILES_ALLOWLIST_SETTING = 'covenCode.guardedFiles.allowlist';

export const UNDEFINED_MATCH_VALUE = Object.freeze({ __covenCodeLiteral: 'undefined' });

export function isUndefinedMatchValue(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && value.__covenCodeLiteral === 'undefined'
      && Object.keys(value).length === 1,
  );
}

export function loadUserPermissionRules(parsed = {}) {
  const settings = readEffectiveSettings(parsed);
  return Array.isArray(settings[PERMISSIONS_SETTING]) ? settings[PERMISSIONS_SETTING] : [];
}

export function builtinPermissionRules() {
  return BUILTIN_PERMISSIONS.map(([action, builtinTool, cmd]) => ({
    action,
    tool: builtinTool,
    matches: builtinTool === 'Bash' ? { cmd: `${cmd}*` } : undefined,
  }));
}

export function commandAllowlistPermissionRules(parsed = {}) {
  const allowlist = readEffectiveSettings(parsed)[COMMAND_ALLOWLIST_SETTING];
  if (!Array.isArray(allowlist)) return [];
  return allowlist
    .map((command) => String(command).trim())
    .filter(Boolean)
    .map((command) => ({
      action: 'allow',
      tool: 'Bash',
      matches: { cmd: commandAllowlistPattern(command) },
    }));
}

function commandAllowlistPattern(command) {
  return `/^${escapeRegex(command)}(?:\\s|$).*/`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
