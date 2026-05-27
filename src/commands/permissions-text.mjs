import { UsageError } from '../cli/parse.mjs';
import { shellQuote, splitShellWords } from '../util/shell.mjs';
import { UNDEFINED_MATCH_VALUE, isUndefinedMatchValue } from './permissions-rules.mjs';

export function formatPermissionRule(rule) {
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

export function parsePermissionText(input) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => parsePermissionRule(splitShellWords(line)));
}

export function parsePermissionRule(tokens) {
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
  if (!Object.hasOwn(current, finalKey)) current[finalKey] = value;
  else if (Array.isArray(current[finalKey])) current[finalKey].push(value);
  else current[finalKey] = [current[finalKey], value];
}
