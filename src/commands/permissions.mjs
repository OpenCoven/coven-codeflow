import { spawnSync } from 'node:child_process';
import { BUILTIN_PERMISSIONS } from '../constants.mjs';
import { readSettings, readEffectiveSettings, writeSettings } from '../settings/load.mjs';
import { globMatch } from '../util/glob.mjs';
import { shellQuote, splitShellWords } from '../util/shell.mjs';
import { UsageError } from '../cli/parse.mjs';

const PERMISSIONS_SETTING = 'covenCode.permissions';
const COMMAND_ALLOWLIST_SETTING = 'covenCode.commands.allowlist';
const DANGEROUSLY_ALLOW_ALL_SETTING = 'covenCode.dangerouslyAllowAll';
const GUARDED_FILES_ALLOWLIST_SETTING = 'covenCode.guardedFiles.allowlist';
const UNDEFINED_MATCH_VALUE = Object.freeze({ __covenCodeLiteral: 'undefined' });

export async function runPermissions(args, stdin = '', parsed = {}) {
  const subcommand = args[0] ?? 'list';
  if (subcommand === 'list') {
    const rules = args.includes('--builtin')
      ? builtinPermissionRules()
      : [...loadUserPermissionRules(parsed), ...builtinPermissionRules()];
    for (const rule of rules) console.log(formatPermissionRule(rule));
    return;
  }

  if (subcommand === 'add') {
    const settings = readSettings(parsed);
    const rule = parsePermissionRule(args.slice(1));
    settings[PERMISSIONS_SETTING] = [rule, ...(settings[PERMISSIONS_SETTING] ?? [])];
    await writeSettings(settings, parsed);
    console.log(`Added permission rule: ${rule.action} ${rule.tool}`);
    return;
  }

  if (subcommand === 'edit') {
    const settings = readSettings(parsed);
    settings[PERMISSIONS_SETTING] = parsePermissionText(stdin);
    await writeSettings(settings, parsed);
    console.log(`Wrote ${settings[PERMISSIONS_SETTING].length} permission rule(s).`);
    return;
  }

  if (subcommand === 'test') {
    const tool = args[1];
    if (!tool) throw new UsageError('permissions test requires a tool name');
    const toolArgs = parseFlagMatches(args.slice(2));
    const context = typeof toolArgs.context === 'string' ? toolArgs.context : 'thread';
    delete toolArgs.context;
    const decision = evaluatePermission(tool, toolArgs, parsed, { context });
    console.log(`tool: ${tool}`);
    console.log(`arguments: ${JSON.stringify(toolArgs)}`);
    console.log(`action: ${decision.action}`);
    if (decision.to) console.log(`to: ${decision.to}`);
    if (decision.matchedRule !== undefined) console.log(`matched-rule: ${decision.matchedRule}`);
    console.log(`source: ${decision.source}`);
    return;
  }

  throw new UsageError(`Unknown permissions command: ${subcommand}`);
}

export function loadUserPermissionRules(parsed = {}) {
  const settings = readEffectiveSettings(parsed);
  return Array.isArray(settings[PERMISSIONS_SETTING]) ? settings[PERMISSIONS_SETTING] : [];
}

function formatPermissionRule(rule) {
  const parts = [rule.action];
  for (const key of ['context', 'to', 'message']) {
    if (rule[key] !== undefined) parts.push(`--${key}`, formatPermissionToken(rule[key]));
  }
  parts.push(formatPermissionToken(rule.tool));
  for (const [key, value] of flattenMatches(rule.matches)) {
    parts.push(`--${key}`, formatPermissionToken(value));
  }
  return parts.join(' ');
}

function flattenMatches(matches, prefix = '') {
  if (!matches) return [];
  const entries = [];
  for (const [key, value] of Object.entries(matches)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      for (const entry of value) entries.push(...flattenMatchValue(fullKey, entry));
    } else {
      entries.push(...flattenMatchValue(fullKey, value));
    }
  }
  return entries;
}

function flattenMatchValue(key, value) {
  if (isUndefinedMatchValue(value)) return [[key, value]];
  if (value && typeof value === 'object' && !Array.isArray(value)) return flattenMatches(value, key);
  return [[key, value]];
}

function formatPermissionToken(value) {
  if (isUndefinedMatchValue(value)) return 'undefined';
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  return /^[A-Za-z0-9_./:@=-]+$/.test(text) ? text : shellQuote(text);
}

function parsePermissionText(input) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => parsePermissionRule(splitShellWords(line)));
}

function parsePermissionRule(tokens) {
  const [action] = tokens;
  const { flags: actionArgs, index: toolIndex } = parseActionArgs(tokens, 1);
  const tool = tokens[toolIndex];
  const rest = tokens.slice(toolIndex + 1);
  if (!action || !tool) throw new UsageError('permission rules require: <action> <tool>');
  const rule = { action, tool, ...actionArgs };
  const matches = parseFlagMatches(rest, { undefinedPattern: true });
  if (Object.keys(matches).length > 0) rule.matches = matches;
  if (matches.to) {
    rule.to = matches.to;
    delete rule.matches.to;
    if (Object.keys(rule.matches).length === 0) delete rule.matches;
  }
  return rule;
}

function parseActionArgs(tokens, startIndex) {
  const flags = {};
  let index = startIndex;
  while (tokens[index]?.startsWith('--')) {
    const key = tokens[index].slice(2);
    flags[key] = parsePermissionValue(tokens[index + 1] ?? '');
    index += 2;
  }
  return { flags, index };
}

export function parseFlagMatches(tokens, options = {}) {
  return parseFlagMatchesWithOptions(tokens, options);
}

function parseFlagMatchesWithOptions(tokens, options = {}) {
  const matches = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = parsePermissionValue(tokens[index + 1] ?? '', options);
    index += 1;
    setMatchValue(matches, key, value);
  }
  return matches;
}

function parsePermissionValue(value, options = {}) {
  if (value === 'undefined') return options.undefinedPattern ? { ...UNDEFINED_MATCH_VALUE } : undefined;
  if (/^(?:true|false|null|-?\d+(?:\.\d+)?)$/.test(value)) return JSON.parse(value);
  return value;
}

function setMatchValue(target, key, value) {
  const parts = key.split('.').filter(Boolean);
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  const finalKey = parts.at(-1) ?? key;
  if (!hasOwn(current, finalKey)) current[finalKey] = value;
  else if (Array.isArray(current[finalKey])) current[finalKey].push(value);
  else current[finalKey] = [current[finalKey], value];
}

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

function builtinPermissionRules() {
  return BUILTIN_PERMISSIONS.map(([action, builtinTool, cmd]) => ({
    action,
    tool: builtinTool,
    matches: builtinTool === 'Bash' ? { cmd: `${cmd}*` } : undefined,
  }));
}

function commandAllowlistPermissionRules(parsed = {}) {
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
  return hasOwn(settings, PERMISSIONS_SETTING)
    || hasOwn(settings, GUARDED_FILES_ALLOWLIST_SETTING)
    || hasOwn(settings, COMMAND_ALLOWLIST_SETTING)
    || settings[DANGEROUSLY_ALLOW_ALL_SETTING] === false;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
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

function isUndefinedMatchValue(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && value.__covenCodeLiteral === 'undefined'
      && Object.keys(value).length === 1,
  );
}
