import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { BUILTIN_TOOLS } from '../constants.mjs';
import { toolsDirs } from '../settings/paths.mjs';
import { readEffectiveSettings } from '../settings/load.mjs';
import { globMatch } from '../util/glob.mjs';

export function listToolboxTools(parsed = {}) {
  const seen = new Set();
  const tools = [];
  for (const dir of toolsDirs(parsed)) {
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
  const settings = readEffectiveSettings(parsed);
  const enabled = settings['covenCode.tools.enable'];
  if (Array.isArray(enabled) && !enabled.some((pattern) => typeof pattern === 'string' && globMatch(pattern, name))) {
    return true;
  }
  const disabled = settings['covenCode.tools.disable'];
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
    env: { ...process.env, TOOLBOX_ACTION: 'describe', AGENT: 'coven-code' },
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
      input: normalizeToolboxInputSchema(parsed.input ?? parsed.args ?? parsed.inputSchema ?? parsed.schema),
      raw: parsed,
    };
  } catch {
    // Fall through to the documented text format.
  }

  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const description = lines
    .filter((line) => line.startsWith('description: '))
    .map((line) => line.replace('description: ', '').trim())
    .join('\n');
  const input = lines
    .filter((line) => !line.startsWith('name: ') && !line.startsWith('description: '))
    .map((line) => {
      const match = line.match(/^([^:]+):\s*(.*)$/);
      return match ? parseTextParameter(match[1], match[2]) : undefined;
    })
    .filter(Boolean);
  return {
    format: 'text',
    description: description || `Toolbox tool at ${filePath}`,
    input,
    raw: stdout,
  };
}

function parseTextParameter(name, definition = '') {
  const [first = '', ...rest] = definition.trim().split(/\s+/);
  const knownTypes = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
  if (!first || first.toLowerCase() === 'optional') {
    return { name, type: 'string', description: ['optional', ...rest].filter(Boolean).join(' ') };
  }
  const optionalSuffix = first.endsWith('?');
  const type = optionalSuffix ? first.slice(0, -1) : first;
  if (knownTypes.has(type)) {
    return { name, type, description: optionalText(rest.join(' '), optionalSuffix) };
  }
  return { name, type: 'string', description: definition.trim() };
}

function optionalText(description, optional) {
  if (!optional) return description.replace(/^\(optional\)\s*/i, 'optional ');
  return description.toLowerCase().startsWith('optional') ? description : `optional ${description}`.trim();
}

function normalizeToolboxInputSchema(input = {}) {
  if (Array.isArray(input)) return input;
  if (input?.type === 'object' && input.properties && typeof input.properties === 'object') {
    return Object.entries(input.properties).map(([name, value]) => ({
      name,
      type: schemaTypeName(value),
      description: value?.description || '',
    }));
  }
  return Object.entries(input).map(([name, value]) => ({
    name,
    type: compactArgType(value),
    description: compactArgDescription(value),
  }));
}

function compactArgType(value) {
  if (Array.isArray(value)) return value[0] || 'string';
  return value?.type || 'string';
}

function compactArgDescription(value) {
  if (Array.isArray(value)) return value[1] || '';
  return value?.description || '';
}

function schemaTypeName(value = {}) {
  const type = value.type || 'string';
  if (type === 'array' && value.items?.type) return `array<${value.items.type}>`;
  return type;
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
  if (shell === 'js') return javascriptToolboxTemplate(name);
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

function javascriptToolboxTemplate(name) {
  return `#!/usr/bin/env bun
const action = process.env.TOOLBOX_ACTION ?? 'describe';

if (action === 'describe') showDescription();
else if (action === 'execute') execute();
else {
  console.error(\`Unknown action: \${action}\`);
  process.exit(1);
}

function showDescription() {
  process.stdout.write([
    'name: ${name}',
    'description: ${name.replaceAll('_', ' ')} toolbox tool',
    'input: string optional Input passed to the tool',
  ].join('\\n'));
  process.stdout.write('\\n');
}

async function execute() {
  const input = await new Response(Bun.stdin).text();
  if (input.trim()) {
    process.stdout.write(input.endsWith('\\n') ? input : \`\${input}\\n\`);
  } else {
    process.stdout.write('${name} executed\\n');
  }
}
`;
}

export function executeToolboxTool(tool, flags, stdin, threadId) {
  const input = formatToolboxInput(tool, flags, stdin);
  return spawnSync(tool.path, {
    input,
    env: {
      ...process.env,
      TOOLBOX_ACTION: 'execute',
      AGENT: 'coven-code',
      COVEN_CODE_THREAD_ID: threadId,
      AGENT_THREAD_ID: threadId,
    },
    encoding: 'utf8',
    shell: false,
  });
}
