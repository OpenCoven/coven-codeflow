import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote, splitShellWords } from '../util/shell.mjs';

export function filesModifiedByToolCall(event = {}) {
  const input = event.input ?? {};
  if ((event.tool === 'edit_file' || event.tool === 'create_file' || event.tool === 'undo_edit') && input.path) {
    return [path.resolve(process.cwd(), String(input.path))];
  }
  if (event.tool === 'apply_patch' && typeof input.patch === 'string') {
    return applyPatchModifiedFiles(input.patch);
  }
  const shellCommand = event.tool === 'Bash' || event.tool === 'shell_command'
    ? input.command ?? input.cmd
    : undefined;
  if (typeof shellCommand === 'string') {
    const files = sedInPlaceModifiedFiles(shellCommand);
    return files.length > 0 ? files : null;
  }
  return null;
}

function applyPatchModifiedFiles(patch) {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
    .map((match) => path.resolve(process.cwd(), match[1].trim()))
    .filter(Boolean);
}

function sedInPlaceModifiedFiles(command) {
  const tokens = splitShellWords(command);
  if (tokens[0] !== 'sed') return [];
  const files = [];
  let sawInPlace = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-i') {
      sawInPlace = true;
      if (tokens[index + 1] === '' || (tokens[index + 1] && !tokens[index + 1].startsWith('-') && !looksLikeSedScript(tokens[index + 1]))) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith('-i')) {
      sawInPlace = true;
      continue;
    }
    if (!sawInPlace || token.startsWith('-') || looksLikeSedScript(token)) continue;
    files.push(path.resolve(process.cwd(), token));
  }
  return files;
}

function looksLikeSedScript(token = '') {
  return /^[a-zA-Z][^/|,;]*[\/|,;]/.test(token);
}

export function toolCallsInMessages(messages = []) {
  const calls = [];
  const resultsById = new Map();
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (block?.type === 'tool_use') {
        calls.push({
          toolUseID: block.id,
          tool: block.name,
          input: block.input ?? {},
        });
        continue;
      }
      if (block?.type !== 'tool_result') continue;
      const toolUseID = block.toolUseID ?? block.tool_use_id;
      if (typeof toolUseID !== 'string' || !toolUseID) continue;
      const status = normalizeToolResultStatus(block);
      if (!status) continue;
      resultsById.set(toolUseID, {
        toolUseID,
        status,
        output: normalizeToolResultOutput(block),
        ...(status === 'error' && typeof block.content === 'string' ? { error: block.content } : {}),
      });
    }
  }

  return calls.flatMap((call) => {
    const result = resultsById.get(call.toolUseID);
    if (!result) return [];
    return [{
      call,
      result: {
        ...result,
        tool: call.tool,
        input: call.input,
      },
    }];
  });
}

function normalizeToolResultStatus(block = {}) {
  if (block.status === 'done' || block.status === 'error' || block.status === 'cancelled') return block.status;
  if (typeof block.is_error === 'boolean') return block.is_error ? 'error' : 'done';
  if (typeof block.isError === 'boolean') return block.isError ? 'error' : 'done';
  return undefined;
}

function normalizeToolResultOutput(block = {}) {
  if (Object.hasOwn(block, 'output')) return block.output;
  if (Object.hasOwn(block, 'content')) return block.content;
  return undefined;
}

export function filePathFromURI(uri) {
  if (!uri) return undefined;
  try {
    return fileURLToPath(String(uri));
  } catch {
    return undefined;
  }
}

export function isPluginUINotAvailableError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'PluginUINotAvailableError') return true;
  if (error.code === 'PLUGIN_UI_NOT_AVAILABLE') return true;
  return /\b(?:no|plugin)\s+plugin\s+ui\s+(?:is\s+)?available\b/i.test(String(error.message ?? ''))
    || /\bplugin\s+ui\s+(?:is\s+)?not\s+available\b/i.test(String(error.message ?? ''));
}

export function runPluginShell(cwd, strings, values) {
  const command = strings.reduce((text, part, index) => {
    return `${text}${part}${index < values.length ? shellQuote(values[index]) : ''}`;
  }, '');
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8' });
  return {
    exitCode: result.status ?? 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 0,
  };
}
