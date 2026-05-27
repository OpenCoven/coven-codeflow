import { UsageError } from '../cli/parse.mjs';
import { readSettings, writeSettings } from '../settings/load.mjs';
import { evaluatePermission, resolvePermissionDecision } from './permissions-eval.mjs';
import {
  PERMISSIONS_SETTING,
  builtinPermissionRules,
  loadUserPermissionRules,
} from './permissions-rules.mjs';
import {
  formatPermissionRule,
  parseFlagMatches,
  parsePermissionRule,
  parsePermissionText,
} from './permissions-text.mjs';

export { resolvePermissionDecision };

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
