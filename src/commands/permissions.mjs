import { BUILTIN_PERMISSIONS } from '../constants.mjs';
import { readSettings, readEffectiveSettings, writeSettings } from '../settings/load.mjs';
import { globMatch } from '../util/glob.mjs';
import { splitShellWords } from '../util/shell.mjs';
import { printRows } from '../util/table.mjs';
import { UsageError } from '../cli/parse.mjs';

export async function runPermissions(args, stdin = '', parsed = {}) {
  const subcommand = args[0] ?? 'list';
  if (subcommand === 'list') {
    const rows = args.includes('--builtin')
      ? BUILTIN_PERMISSIONS
      : [...readUserPermissionRows(parsed), ...BUILTIN_PERMISSIONS];
    printRows(rows);
    return;
  }

  if (subcommand === 'add') {
    const settings = readSettings(parsed);
    const rule = parsePermissionRule(args.slice(1));
    settings['amp.permissions'] = [rule, ...(settings['amp.permissions'] ?? [])];
    await writeSettings(settings, parsed);
    console.log(`Added permission rule: ${rule.action} ${rule.tool}`);
    return;
  }

  if (subcommand === 'edit') {
    const settings = readSettings(parsed);
    settings['amp.permissions'] = parsePermissionText(stdin);
    await writeSettings(settings, parsed);
    console.log(`Wrote ${settings['amp.permissions'].length} permission rule(s).`);
    return;
  }

  if (subcommand === 'test') {
    const tool = args[1];
    if (!tool) throw new UsageError('permissions test requires a tool name');
    const toolArgs = parseFlagMatches(args.slice(2));
    const decision = evaluatePermission(tool, toolArgs, parsed);
    console.log(`tool: ${tool}`);
    console.log(`arguments: ${JSON.stringify(toolArgs)}`);
    console.log(`action: ${decision.action}`);
    if (decision.to) console.log(`to: ${decision.to}`);
    return;
  }

  throw new UsageError(`Unknown permissions command: ${subcommand}`);
}

function readUserPermissionRows(parsed = {}) {
  return loadUserPermissionRules(parsed).map((rule) => [
    rule.action,
    rule.tool,
    rule.matches ? JSON.stringify(rule.matches) : rule.to ? `to=${rule.to}` : '*',
  ]);
}

export function loadUserPermissionRules(parsed = {}) {
  const settings = readEffectiveSettings(parsed);
  return Array.isArray(settings['amp.permissions']) ? settings['amp.permissions'] : [];
}

function parsePermissionText(input) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => parsePermissionRule(splitShellWords(line)));
}

function parsePermissionRule(tokens) {
  const [action, tool, ...rest] = tokens;
  if (!action || !tool) throw new UsageError('permission rules require: <action> <tool>');
  const rule = { action, tool };
  const matches = parseFlagMatches(rest);
  if (Object.keys(matches).length > 0) rule.matches = matches;
  if (matches.to) {
    rule.to = matches.to;
    delete rule.matches.to;
    if (Object.keys(rule.matches).length === 0) delete rule.matches;
  }
  return rule;
}

export function parseFlagMatches(tokens) {
  const matches = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = tokens[index + 1] ?? '';
    index += 1;
    if (matches[key] === undefined) matches[key] = value;
    else if (Array.isArray(matches[key])) matches[key].push(value);
    else matches[key] = [matches[key], value];
  }
  return matches;
}

export function evaluatePermission(tool, toolArgs, parsed = {}) {
  const rules = [
    ...loadUserPermissionRules(parsed),
    ...BUILTIN_PERMISSIONS.map(([action, builtinTool, cmd]) => ({
      action,
      tool: builtinTool,
      matches: builtinTool === 'Bash' ? { cmd: `${cmd}*` } : undefined,
    })),
  ];

  for (const rule of rules) {
    if (!globMatch(rule.tool, tool)) continue;
    if (!matchesArguments(rule.matches, toolArgs)) continue;
    return { action: rule.action, to: rule.to };
  }

  return { action: 'reject' };
}

function matchesArguments(matches, toolArgs) {
  if (!matches || Object.keys(matches).length === 0) return true;
  for (const [key, pattern] of Object.entries(matches)) {
    const actual = toolArgs[key];
    if (actual === undefined) return false;
    const patterns = Array.isArray(pattern) ? pattern : [pattern];
    if (!patterns.some((entry) => globMatch(String(entry), String(actual)))) return false;
  }
  return true;
}
