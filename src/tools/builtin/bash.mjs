import { spawnSync } from 'node:child_process';
import { THREAD_URL_BASE } from '../../constants.mjs';
import { resolvePermissionDecision } from '../../commands/permissions.mjs';
import { runPluginEventHandlers } from '../../plugins/discover.mjs';
import { readEffectiveSettings } from '../../settings/load.mjs';
import { shellQuote, splitShellWords } from '../../util/shell.mjs';
import { isToolDisabled } from '../toolbox.mjs';
import {
  applyToolCallDecision,
  createToolUseID,
  permissionDeniedOutput,
  pluginResultOutput,
  pluginToolCallEvent,
  pluginToolResultDecisionExitCode,
  pluginToolResultEvent,
  pluginToolUseBlock,
  toolCallDecisionToolRun,
  validateToolCallDecision,
} from './runtime.mjs';

export const TOOL_NAME = 'Bash';

export async function executePromptBashToolRequest(request, stdin = '', parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled(TOOL_NAME, 'built-in', parsed)) return { output: `Tool disabled: ${TOOL_NAME}` };
  request = { ...request, flags: normalizeBashInput(request.flags) };
  if (!request.flags.command) return { output: 'Bash requires --command' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(TOOL_NAME, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(TOOL_NAME, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(TOOL_NAME, request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeBashInput(callResult.request.flags) };
  const decision = resolvePermissionDecision(TOOL_NAME, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(TOOL_NAME, decision),
      permissionDenials: [{ tool: TOOL_NAME, action: decision.action, reason: 'permission' }],
    };
  }
  const result = spawnSync(commandForBashExecution(request.flags.command, parsed, threadId), {
    cwd: process.cwd(),
    input: stdin,
    shell: true,
    encoding: 'utf8',
    env: {
      ...process.env,
      COVEN_CODE_THREAD_ID: threadId,
      AGENT_THREAD_ID: threadId,
    },
  });
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 0;
  const output = (result.stdout ?? '').trimEnd();
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(TOOL_NAME, request.flags, (result.status ?? 0) === 0 ? 'done' : 'error', output, threadId, toolUseID),
  );
  const exitCode = pluginToolResultDecisionExitCode(resultDecision, result.status ?? 0);
  return {
    output: pluginResultOutput(resultDecision, output),
    exitCode,
    toolUse: pluginToolUseBlock(TOOL_NAME, request.flags, toolUseID),
  };
}

function normalizeBashInput(input = {}) {
  const command = String(input.command ?? input.cmd ?? '');
  return { ...input, command, cmd: command };
}

function commandForBashExecution(command, parsed = {}, threadId = '') {
  if (!isGitCommitCommand(command)) return command;
  const trailers = gitCommitTrailers(parsed, threadId);
  if (!trailers.length) return command;
  return `${command} ${trailers.map((trailer) => `--trailer ${shellQuote(trailer)}`).join(' ')}`;
}

function isGitCommitCommand(command) {
  const words = splitShellWords(command);
  if (words[0] !== 'git') return false;
  return gitSubcommand(words) === 'commit';
}

function gitSubcommand(words) {
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === '-C' || word === '-c' || word === '--git-dir' || word === '--work-tree' || word === '--namespace') {
      index += 1;
      continue;
    }
    if (word.startsWith('-')) continue;
    return word;
  }
  return '';
}

function gitCommitTrailers(parsed, threadId) {
  const settings = readEffectiveSettings(parsed);
  const trailers = [];
  if (settings['covenCode.git.commit.thread.enabled'] !== false && threadId) {
    trailers.push(`Coven-Code-Thread: ${THREAD_URL_BASE}/${threadId}`);
  }
  if (settings['covenCode.git.commit.coauthor.enabled'] === true) {
    trailers.push('Co-authored-by: Coven Code <coven-code@opencoven.local>');
  }
  return trailers;
}
