export class UsageError extends Error {}

export function parseGlobalArgs(args) {
  const parsed = {
    execute: false,
    prompt: '',
    streamJson: false,
    streamJsonThinking: false,
    streamJsonInput: false,
    dangerouslyAllowAll: false,
    help: false,
    version: false,
    mode: 'smart',
    reasoningEffort: undefined,
    mcpConfig: undefined,
    settingsFile: undefined,
    labels: [],
    visibility: undefined,
    archive: false,
    continueThread: false,
    toolbox: undefined,
    skills: undefined,
    ide: undefined,
    positionals: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--version' || arg === '-v') parsed.version = true;
    else if (arg === '--execute' || arg === '-x') {
      parsed.execute = true;
      const next = args[index + 1];
      if (next && !next.startsWith('-')) {
        parsed.prompt = next;
        index += 1;
      }
    } else if (arg === '--stream-json') parsed.streamJson = true;
    else if (arg === '--stream-json-thinking') {
      parsed.streamJson = true;
      parsed.streamJsonThinking = true;
    } else if (arg === '--stream-json-input') parsed.streamJsonInput = true;
    else if (arg === '--dangerously-allow-all') parsed.dangerouslyAllowAll = true;
    else if (arg === '--mcp-config') {
      parsed.mcpConfig = requireFlagValue(args, index, arg);
      index += 1;
    } else if (arg === '--settings-file') {
      parsed.settingsFile = requireFlagValue(args, index, arg);
      index += 1;
    } else if (arg === '--label') {
      parsed.labels.push(requireFlagValue(args, index, arg));
      index += 1;
    } else if (arg === '--visibility') {
      parsed.visibility = requireFlagValue(args, index, arg);
      index += 1;
    } else if (arg === '--archive') {
      parsed.archive = true;
    } else if (arg === '--continue') {
      const next = args[index + 1];
      if (next && /^T-[A-Za-z0-9-]+$/.test(next)) {
        parsed.continueThread = next;
        index += 1;
      } else {
        parsed.continueThread = true;
      }
    } else if (arg === '--toolbox') {
      parsed.toolbox = requireFlagValue(args, index, arg);
      index += 1;
    } else if (arg === '--skills') {
      parsed.skills = requireFlagValue(args, index, arg);
      index += 1;
    } else if (arg === '--mode') {
      parsed.mode = requireFlagValue(args, index, arg);
      index += 1;
    } else if (arg === '--reasoning-effort') {
      parsed.reasoningEffort = requireFlagValue(args, index, arg);
      index += 1;
    } else if (arg === '--jetbrains') parsed.ide = 'jetbrains';
    else parsed.positionals.push(arg);
  }

  return parsed;
}

function requireFlagValue(args, index, flag) {
  const next = args[index + 1];
  if (next === undefined) throw new UsageError(`${flag} requires a value`);
  return next;
}
