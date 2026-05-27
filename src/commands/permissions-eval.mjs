import { spawnSync } from 'node:child_process';
import { readEffectiveSettings } from '../settings/load.mjs';
import { globMatch } from '../util/glob.mjs';
import {
  COMMAND_ALLOWLIST_SETTING,
  DANGEROUSLY_ALLOW_ALL_SETTING,
  GUARDED_FILES_ALLOWLIST_SETTING,
  PERMISSIONS_SETTING,
  builtinPermissionRules,
  commandAllowlistPermissionRules,
  isUndefinedMatchValue,
  loadUserPermissionRules,
} from './permissions-rules.mjs';

export function evaluatePermission(tool, toolArgs, parsed = {}, options = {}) {
  const ruleGroups = [
    { source: 'user', rules: loadUserPermissionRules(parsed) },
    { source: 'command-allowlist', rules: commandAllowlistPermissionRules(parsed) },
    {
      source: 'built-in',
      rules: builtinPermissionRules(),
    },
  ];

  for (const group of ruleGroups) {
    for (const [index, rule] of group.rules.entries()) {
      if (!globMatch(rule.tool, tool)) continue;
      if (!matchesContext(rule.context, options.context ?? 'thread')) continue;
      if (!matchesArguments(rule.matches, toolArgs)) continue;
      return {
        action: rule.action,
        to: rule.to,
        message: rule.message,
        matchedRule: index,
        source: group.source,
      };
    }
  }

  return { action: 'reject', source: 'default' };
}

export function resolvePermissionDecision(tool, toolArgs, parsed = {}, options = {}) {
  const settings = readEffectiveSettings(parsed);
  if (isDangerouslyAllowAll(parsed, settings)) return { action: 'allow', source: 'dangerously-allow-all' };
  if (!legacyPermissionsConfigured(settings)) return { action: 'allow', source: 'default-no-approval' };
  const decision = evaluatePermission(tool, toolArgs, parsed, options);
  if (decision.action !== 'delegate') return decision;
  if (!decision.to) {
    return { ...decision, action: 'reject', message: 'Delegate permission rule is missing a target program' };
  }

  const result = spawnSync(decision.to, {
    input: `${JSON.stringify(toolArgs)}\n`,
    env: {
      ...process.env,
      AGENT: 'coven-code',
      AGENT_TOOL_NAME: tool,
      COVEN_CODE_THREAD_ID: options.threadId ?? '',
      AGENT_THREAD_ID: options.threadId ?? '',
    },
    encoding: 'utf8',
    shell: false,
  });

  if (result.status === 0) return { ...decision, action: 'allow', delegatedAction: 'allow' };
  if (result.status === 1) return { ...decision, action: 'ask', delegatedAction: 'ask' };
  return {
    ...decision,
    action: 'reject',
    delegatedAction: 'reject',
    message: result.stderr.trim() || result.error?.message || `Permission delegate ${decision.to} rejected the tool call`,
  };
}

function isDangerouslyAllowAll(parsed = {}, settings = readEffectiveSettings(parsed)) {
  if (parsed.dangerouslyAllowAll) return true;
  return settings[DANGEROUSLY_ALLOW_ALL_SETTING] === true;
}

function legacyPermissionsConfigured(settings = {}) {
  return Object.hasOwn(settings, PERMISSIONS_SETTING)
    || Object.hasOwn(settings, GUARDED_FILES_ALLOWLIST_SETTING)
    || Object.hasOwn(settings, COMMAND_ALLOWLIST_SETTING)
    || settings[DANGEROUSLY_ALLOW_ALL_SETTING] === false;
}

function matchesContext(ruleContext, actualContext) {
  return !ruleContext || ruleContext === actualContext;
}

function matchesArguments(matches, toolArgs) {
  if (!matches || Object.keys(matches).length === 0) return true;
  for (const [key, pattern] of Object.entries(matches)) {
    const actual = valueAtPath(toolArgs, key);
    if (!matchesPattern(pattern, actual)) return false;
  }
  return true;
}

function matchesPattern(pattern, actual) {
  if (isUndefinedMatchValue(pattern)) return actual === undefined;
  if (Array.isArray(pattern)) return pattern.some((entry) => matchesPattern(entry, actual));
  if (pattern && typeof pattern === 'object') {
    if (!actual || typeof actual !== 'object') return false;
    return Object.entries(pattern).every(([key, value]) => matchesPattern(value, valueAtPath(actual, key)));
  }
  if (typeof pattern === 'string') {
    if (typeof actual !== 'string') return false;
    if (isRegexPattern(pattern)) return new RegExp(pattern.slice(1, -1)).test(actual);
    return globMatch(pattern, actual);
  }
  return Object.is(pattern, actual);
}

function isRegexPattern(value) {
  return value.length >= 2 && value.startsWith('/') && value.endsWith('/');
}

function valueAtPath(value, key) {
  return key.split('.').reduce((current, part) => current?.[part], value);
}
