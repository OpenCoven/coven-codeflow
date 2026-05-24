import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { BUILTIN_TOOLS } from '../constants.mjs';
import { toolsDirs } from '../settings/paths.mjs';
import { readEffectiveSettings } from '../settings/load.mjs';
import { globMatch } from '../util/glob.mjs';

export function listToolboxTools() {
  const seen = new Set();
  const tools = [];
  for (const dir of toolsDirs()) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const filePath = path.join(dir, entry);
      if (!statSync(filePath).isFile()) continue;
      const name = `tb__${path.basename(filePath)}`;
      if (seen.has(name)) continue;
      seen.add(name);
      const schema = describeToolboxTool(filePath);
      tools.push({ name, path: filePath, description: schema.description, schema });
    }
  }
  return tools;
}

export function isToolDisabled(name, kind, parsed = {}) {
  const disabled = readEffectiveSettings(parsed)['amp.tools.disable'];
  if (!Array.isArray(disabled)) return false;
  return disabled.some((pattern) => {
    if (typeof pattern !== 'string') return false;
    if (pattern.startsWith('builtin:')) {
      return kind === 'built-in' && globMatch(pattern.slice('builtin:'.length), name);
    }
    return globMatch(pattern, name);
  });
}

export function toolKindForName(name) {
  if (BUILTIN_TOOLS.some(([builtinName]) => builtinName === name)) return 'built-in';
  if (name.startsWith('tb__')) return 'toolbox';
  if (name.startsWith('mcp__')) return 'local-mcp';
  return '';
}

function describeToolboxTool(filePath) {
  const result = spawnSync(filePath, {
    env: { ...process.env, TOOLBOX_ACTION: 'describe', AGENT: 'amp' },
    encoding: 'utf8',
    shell: false,
  });
  return parseToolboxDescription(result.stdout, filePath);
}

function parseToolboxDescription(stdout, filePath) {
  try {
    const parsed = JSON.parse(stdout);
    return {
      format: 'json',
      description: parsed.description || `Toolbox tool at ${filePath}`,
      input: normalizeToolboxInputSchema(parsed.input ?? parsed.inputSchema ?? parsed.schema),
      raw: parsed,
    };
  } catch {
    // Fall through to the documented text format.
  }

  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const description = lines
    .find((line) => line.startsWith('description: '))
    ?.replace('description: ', '')
    .trim();
  const input = lines
    .filter((line) => !line.startsWith('name: ') && !line.startsWith('description: '))
    .map((line) => {
      const match = line.match(/^([^:]+):\s+(\S+)(?:\s+(.*))?$/);
      return match ? { name: match[1], type: match[2], description: match[3] || '' } : undefined;
    })
    .filter(Boolean);
  return {
    format: 'text',
    description: description || `Toolbox tool at ${filePath}`,
    input,
    raw: stdout,
  };
}

function normalizeToolboxInputSchema(input = {}) {
  if (Array.isArray(input)) return input;
  return Object.entries(input).map(([name, value]) => ({
    name,
    type: value?.type || 'string',
    description: value?.description || '',
  }));
}

export function printToolboxSchema(tool) {
  console.log(`# ${tool.name} (toolbox: ${tool.path})`);
  console.log('');
  console.log(tool.schema.description);
  if (tool.schema.input.length === 0) return;
  console.log('');
  console.log('# Schema');
  console.log('');
  for (const input of tool.schema.input) {
    const suffix = input.description ? `: ${input.description}` : '';
    console.log(`- ${input.name} (${input.type})${suffix}`);
  }
}

export function parseToolUseArgs(args) {
  const result = {
    toolName: '',
    flags: {},
    onlyOutput: false,
    threadId: `T-${randomUUID()}`,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--only' && args[index + 1] === 'output') {
      result.onlyOutput = true;
      index += 1;
      continue;
    }
    if (token === '--thread') {
      result.threadId = args[index + 1] ?? result.threadId;
      index += 1;
      continue;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : true;
      if (value !== true) index += 1;
      result.flags[key] = value;
      continue;
    }
    if (!result.toolName) result.toolName = token;
  }

  return result;
}

function formatToolboxInput(tool, flags, stdin) {
  if (stdin.length > 0) return stdin;
  if (Object.keys(flags).length === 0) return '';
  if (tool.schema.format === 'text') {
    return Object.entries(flags).map(([key, value]) => `${key}: ${value}`).join('\n') + '\n';
  }
  return `${JSON.stringify(flags)}\n`;
}

export function normalizeToolName(name = '') {
  return name.startsWith('tb__') ? name : `tb__${name}`;
}

export function toolboxTemplate(shell, name) {
  return `#!/usr/bin/env ${shell}
set -euo pipefail

if [ "\${TOOLBOX_ACTION:-describe}" = "describe" ]; then
  cat <<'EOF'
name: ${name}
description: ${name.replaceAll('_', ' ')} toolbox tool
input: string optional Input passed to the tool
EOF
  exit 0
fi

input="$(cat || true)"
if [ -n "$input" ]; then
  printf '%s\\n' "$input"
else
  printf '${name} executed\\n'
fi
`;
}

export function executeToolboxTool(tool, flags, stdin, threadId) {
  const input = formatToolboxInput(tool, flags, stdin);
  return spawnSync(tool.path, {
    input,
    env: {
      ...process.env,
      TOOLBOX_ACTION: 'execute',
      AGENT: 'amp',
      AMP_THREAD_ID: threadId,
      AGENT_THREAD_ID: threadId,
    },
    encoding: 'utf8',
    shell: false,
  });
}
