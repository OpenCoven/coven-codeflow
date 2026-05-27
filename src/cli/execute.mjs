import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BUILTIN_TOOLS } from '../constants.mjs';
import { estimateUsage, localAgentResponse } from '../agent/local.mjs';
import {
  listActiveMcpServerEntries,
} from '../mcp/discover.mjs';
import { discoverMcpToolRows } from '../mcp/probe.mjs';
import {
  loadPlugins,
  runPluginEventHandlers,
} from '../plugins/discover.mjs';
import { discoverAgentFiles, firstGuidanceInDir } from '../commands/agents.mjs';
import {
  isToolDisabled,
  listToolboxTools,
  toolKindForName,
} from '../tools/toolbox.mjs';
import { executePromptToolRequest } from '../tools/builtin/index.mjs';
import { toolResultContent } from '../tools/builtin/runtime.mjs';
import { persistThreadMessages, threadContinuationPrompt } from '../threads/store.mjs';
import { readEffectiveSettings } from '../settings/load.mjs';
import { expandFileReferences, expandThreadReferences } from './refs.mjs';
import { UsageError } from './parse.mjs';
import { reasoningEffortForMode } from './reasoning.mjs';
import { notifyAgentComplete } from './notifications.mjs';
import { globToRegex } from '../util/glob.mjs';
import { displayCwd, emitJson } from '../util/fs.mjs';
import {
  streamJsonInputMessages,
  streamJsonOutputUserContent,
  streamJsonPermissionDenials,
  streamJsonResultMessage,
  streamJsonTurnCount,
  toolRunParent,
} from './stream-json.mjs';

const MAX_AGENT_CONTINUATIONS = 8;

export async function runExecute(parsed, stdin, options = {}) {
  const started = Date.now();
  if (parsed.streamJsonInput && parsed.streamJson) {
    return runStreamJsonInputExecute(parsed, stdin, options, started);
  }

  const prompt = combinePrompt(parsed.prompt, stdin, parsed.streamJsonInput);
  const sessionId = options.thread?.id ?? `T-${randomUUID()}`;
  const plugins = await loadPlugins(process.cwd());
  await runSessionStartHandlers(plugins, sessionId);
  const sequence = await runExecuteTurnSequence({
    initialPrompt: prompt,
    stdin,
    sessionId,
    parsed,
    plugins,
    thread: options.thread,
  });
  const { turns, errorSubtype } = sequence;
  const result = turns.at(-1)?.result ?? '';

  if (parsed.streamJson) {
    const activeMcpServers = listActiveMcpServerEntries(parsed, turns.map((turn) => turn.prompt).join('\n\n'));
    const tools = [
      ...BUILTIN_TOOLS.map(([name]) => name),
      ...listToolboxTools(parsed).map((tool) => tool.name),
      ...plugins.tools.map((tool) => tool.name),
      ...(await discoverMcpToolRows(activeMcpServers)).map(([name]) => name),
    ].filter((name) => !isToolDisabled(name, toolKindForName(name), parsed));
    emitJson({
      type: 'system',
      subtype: 'init',
      cwd: displayCwd(),
      session_id: sessionId,
      tools,
      mcp_servers: activeMcpServers.map(({ name }) => ({ name, status: 'connected' })),
      agent_mode: parsed.mode,
      reasoning_effort: reasoningEffortForMode(parsed.mode, parsed.reasoningEffort),
    });
    for (const turn of turns) {
      emitJson({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: turn.prompt }] },
        parent_tool_use_id: null,
        session_id: sessionId,
      });
      if (turn.toolRun?.toolUse) {
        emitJson({
          type: 'assistant',
          message: {
            type: 'message',
            role: 'assistant',
            content: [turn.toolRun.toolUse],
            stop_reason: 'tool_use',
            usage: estimateUsage(turn.prompt, JSON.stringify(turn.toolRun.toolUse.input)),
          },
          parent_tool_use_id: null,
          session_id: sessionId,
        });
        for (const subagentMessage of turn.toolRun.subagentMessages ?? []) {
          emitJson({
            type: 'assistant',
            message: {
              type: 'message',
              role: 'assistant',
              content: assistantStreamContent(subagentMessage.text ?? '', parsed),
              stop_reason: 'end_turn',
              usage: estimateUsage(turn.prompt, subagentMessage.text ?? ''),
            },
            parent_tool_use_id: turn.toolRun.toolUse.id,
            session_id: sessionId,
          });
        }
        emitJson({
          type: 'user',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: turn.toolRun.toolUse.id,
              content: toolResultContent(turn.toolRun),
              is_error: turn.toolRun.exitCode !== 0,
            }],
          },
          parent_tool_use_id: toolRunParent(turn.toolRun, 'toolResultParentToolUseId', null),
          session_id: sessionId,
        });
      }
      emitJson({
        type: 'assistant',
        message: {
          type: 'message',
          role: 'assistant',
          content: assistantStreamContent(turn.result, parsed),
          stop_reason: 'end_turn',
          usage: estimateUsage(turn.prompt, turn.result),
        },
        parent_tool_use_id: turn.toolRun ? toolRunParent(turn.toolRun, 'finalParentToolUseId', null) : null,
        session_id: sessionId,
      });
    }
    emitJson(streamJsonResultMessage({
      started,
      isError: errorSubtype !== undefined || turns.some((turn) => (turn.toolRun?.exitCode ?? 0) !== 0),
      errorSubtype,
      numTurns: streamJsonTurnCount(turns),
      result: errorSubtype === 'error_max_turns' ? 'Maximum agent continuation turns exceeded' : result,
      sessionId,
      usage: estimateUsage(turns.map((turn) => turn.prompt).join('\n'), result),
      permissionDenials: streamJsonPermissionDenials(turns.flatMap((turn) => turn.toolRun?.permissionDenials ?? [])),
    }));
    const thread = await persistThreadMessages(sessionId, turnMessages(turns), parsed.mode, options.thread, parsed);
    notifyAgentComplete(parsed);
    return thread;
  }

  process.stdout.write(result.endsWith('\n') ? result : `${result}\n`);
  const thread = await persistThreadMessages(sessionId, turnMessages(turns), parsed.mode, options.thread, parsed);
  notifyAgentComplete(parsed);
  return thread;
}

async function runExecuteTurnSequence({ initialPrompt, stdin, sessionId, parsed, plugins, thread }) {
  const turns = [];
  let prompt = initialPrompt;
  let continuationCount = 0;
  let errorSubtype;
  while (prompt !== undefined) {
    const turnStdin = turns.length === 0 ? stdin : '';
    const turn = await runExecuteTurn(prompt, turnStdin, sessionId, parsed, plugins, thread, turns);
    turns.push(turn);
    const nextPrompt = agentContinuationMessage(turn.endDecision);
    if (!nextPrompt) break;
    continuationCount += 1;
    if (continuationCount > MAX_AGENT_CONTINUATIONS) {
      errorSubtype = 'error_max_turns';
      process.exitCode = 1;
      break;
    }
    prompt = nextPrompt;
  }
  return { turns, errorSubtype };
}

async function runExecuteTurn(prompt, stdin, sessionId, parsed, plugins, thread, priorTurns = []) {
  const messageId = createThreadMessageID();
  const startDecision = await runPluginEventHandlers(plugins.handlers['agent.start'], {
    message: prompt,
    id: messageId,
    thread: { id: sessionId },
  });
  const promptWithPluginContext = appendAgentStartMessage(prompt, startDecision);
  const expandedPrompt = expandFileReferences(promptWithPluginContext, { parsed });
  const guidancePrompt = expandAgentGuidanceReferences(expandedPrompt, parsed);
  const turnPrompt = guidancePrompt ? `${guidancePrompt}\n${expandedPrompt}` : expandedPrompt;
  const contextThread = threadContextForTurn(thread, sessionId, priorTurns);
  const modelPrompt = contextThread
    ? threadContinuationPrompt(contextThread, turnPrompt)
    : expandThreadReferences(turnPrompt);
  const toolRun = await executePromptToolRequest(prompt, stdin, sessionId, parsed, plugins);
  const result = toolRun?.output ?? localAgentResponse(applySystemPrompt(modelPrompt, parsed), stdin);
  const endDecision = await runPluginEventHandlers(plugins.handlers['agent.end'], {
    message: prompt,
    id: messageId,
    result,
    status: agentTurnStatus(toolRun),
    messages: pluginMessagesForTurn(prompt, result, toolRun, messageId),
    thread: { id: sessionId },
  });
  return { prompt, result, toolRun, endDecision };
}

function agentTurnStatus(toolRun) {
  return (toolRun?.exitCode ?? 0) === 0 ? 'done' : 'error';
}

function createThreadMessageID() {
  return `msg_${randomUUID()}`;
}

function appendAgentStartMessage(prompt, decision = {}) {
  validateAgentStartDecision(decision);
  const content = decision.message?.content.trim() ?? '';
  if (!content) return prompt;
  return prompt ? `${prompt}\n\n${content}` : content;
}

function validateAgentStartDecision(decision = {}) {
  if (!decision || typeof decision !== 'object' || !Object.hasOwn(decision, 'message')) return;
  if (Object.keys(decision).some((key) => key !== 'message')) {
    throw new Error('plugin agent.start fields must match the documented shape');
  }
  if (!decision.message || typeof decision.message !== 'object' || Array.isArray(decision.message)) {
    throw new Error('plugin agent.start message must be an object');
  }
  if (Object.keys(decision.message).some((key) => key !== 'content' && key !== 'display')) {
    throw new Error('plugin agent.start message fields must be content and display');
  }
  if (typeof decision.message?.content !== 'string') {
    throw new Error('plugin agent.start message content must be a string');
  }
  if (decision.message.display !== true) {
    throw new Error('plugin agent.start message display must be true');
  }
}

function threadContextForTurn(thread, sessionId, priorTurns = []) {
  if (!thread && priorTurns.length === 0) return undefined;
  return {
    id: thread?.id ?? sessionId,
    messages: [
      ...(thread?.messages ?? []),
      ...turnMessages(priorTurns),
    ],
  };
}

function turnMessages(turns) {
  return turns.flatMap((turn) => [
    { role: 'user', content: turn.prompt },
    { role: 'assistant', content: turn.result },
  ]);
}

function pluginMessagesForTurn(prompt, result, toolRun, messageId = createThreadMessageID()) {
  const messages = [{ role: 'user', id: messageId, content: textContent(prompt) }];
  if (toolRun?.toolUse) {
    messages.push({ role: 'assistant', id: createThreadMessageID(), content: [toolRun.toolUse] });
    messages.push({
      role: 'user',
      id: createThreadMessageID(),
      content: [{
        type: 'tool_result',
        toolUseID: toolRun.toolUse.id,
        output: toolResultContent(toolRun),
        status: toolRun.exitCode !== 0 ? 'error' : 'done',
      }],
    });
  }
  messages.push({ role: 'assistant', id: createThreadMessageID(), content: textContent(result) });
  return messages;
}

function textContent(text) {
  return [{ type: 'text', text: String(text ?? '') }];
}

function agentContinuationMessage(decision) {
  validateAgentEndDecision(decision);
  if (decision?.action !== 'continue') return undefined;
  return typeof decision.userMessage === 'string' && decision.userMessage.trim()
    ? decision.userMessage
    : undefined;
}

function validateAgentEndDecision(decision) {
  if (decision === undefined) return;
  if (decision?.action === 'allow') return;
  if (!decision || typeof decision !== 'object' || decision.action !== 'continue') {
    throw new Error('plugin agent.end action must be continue');
  }
  if (typeof decision.userMessage !== 'string') {
    throw new Error('plugin agent.end continue userMessage must be a string');
  }
}

async function runStreamJsonInputExecute(parsed, stdin, options = {}, started = Date.now()) {
  const sessionId = options.thread?.id ?? `T-${randomUUID()}`;
  const inputMessages = streamJsonInputMessages(parsed.prompt, stdin);
  const combinedPrompt = inputMessages.map((message) => message.text).filter(Boolean).join('\n\n');
  const plugins = await loadPlugins(process.cwd());
  await runSessionStartHandlers(plugins, sessionId);
  const activeMcpServers = listActiveMcpServerEntries(parsed, combinedPrompt);
  const tools = [
    ...BUILTIN_TOOLS.map(([name]) => name),
    ...listToolboxTools(parsed).map((tool) => tool.name),
    ...plugins.tools.map((tool) => tool.name),
    ...(await discoverMcpToolRows(activeMcpServers)).map(([name]) => name),
  ].filter((name) => !isToolDisabled(name, toolKindForName(name), parsed));
  emitJson({
    type: 'system',
    subtype: 'init',
    cwd: displayCwd(),
    session_id: sessionId,
    tools,
    mcp_servers: activeMcpServers.map(({ name }) => ({ name, status: 'connected' })),
    agent_mode: parsed.mode,
    reasoning_effort: reasoningEffortForMode(parsed.mode, parsed.reasoningEffort),
  });

  const transcript = [];
  const persistedMessages = [];
  const permissionDenials = [];
  let result = '';
  let parentToolUseId = null;
  let numTurns = 0;
  let isError = false;

  for (const input of inputMessages) {
    const messageId = createThreadMessageID();
    const startDecision = await runPluginEventHandlers(plugins.handlers['agent.start'], {
      message: input.text,
      id: messageId,
      thread: { id: sessionId },
    });
    const inputTextWithPluginContext = appendAgentStartMessage(input.text, startDecision);
    const expandedPrompt = expandFileReferences(inputTextWithPluginContext, { parsed });
    const guidancePrompt = expandAgentGuidanceReferences(expandedPrompt, parsed);
    const turnPrompt = guidancePrompt ? `${guidancePrompt}\n${expandedPrompt}` : expandedPrompt;
    const modelPrompt = modelPromptWithTranscript(turnPrompt, transcript, options.thread, parsed);
    const toolRun = await executePromptToolRequest(input.text, '', sessionId, parsed, plugins);
    result = toolRun?.output ?? localAgentResponse(modelPrompt, '');
    numTurns += streamJsonTurnCount([{ toolRun }]);
    if (toolRun?.permissionDenials) permissionDenials.push(...toolRun.permissionDenials);
    if ((toolRun?.exitCode ?? 0) !== 0) isError = true;

    emitJson({
      type: 'user',
      ...(input.steer ? { steer: true } : {}),
      message: { role: 'user', content: streamJsonOutputUserContent(input.content) },
      parent_tool_use_id: null,
      session_id: sessionId,
    });
    if (toolRun?.toolUse) {
      emitJson({
        type: 'assistant',
        message: {
          type: 'message',
          role: 'assistant',
          content: [toolRun.toolUse],
          stop_reason: 'tool_use',
          usage: estimateUsage(input.text, JSON.stringify(toolRun.toolUse.input)),
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      });
      for (const subagentMessage of toolRun.subagentMessages ?? []) {
        emitJson({
          type: 'assistant',
          message: {
            type: 'message',
            role: 'assistant',
            content: assistantStreamContent(subagentMessage.text ?? '', parsed),
            stop_reason: 'end_turn',
            usage: estimateUsage(input.text, subagentMessage.text ?? ''),
          },
          parent_tool_use_id: toolRun.toolUse.id,
          session_id: sessionId,
        });
      }
      emitJson({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolRun.toolUse.id,
            content: toolResultContent(toolRun),
            is_error: toolRun.exitCode !== 0,
          }],
        },
        parent_tool_use_id: toolRunParent(toolRun, 'toolResultParentToolUseId', null),
        session_id: sessionId,
      });
      parentToolUseId = toolRunParent(toolRun, 'finalParentToolUseId', null);
    }
    emitJson({
      type: 'assistant',
      message: {
        type: 'message',
        role: 'assistant',
        content: assistantStreamContent(result, parsed),
        stop_reason: 'end_turn',
        usage: estimateUsage(input.text, result),
      },
      parent_tool_use_id: parentToolUseId,
      session_id: sessionId,
    });
    await runPluginEventHandlers(plugins.handlers['agent.end'], {
      message: input.text,
      id: messageId,
      result,
      status: agentTurnStatus(toolRun),
      messages: pluginMessagesForTurn(input.text, result, toolRun, messageId),
      thread: { id: sessionId },
    });
    transcript.push({ user: input.text, assistant: result });
    persistedMessages.push(
      { role: 'user', content: input.text },
      { role: 'assistant', content: result },
    );
  }

  emitJson(streamJsonResultMessage({
    started,
    isError,
    numTurns,
    result,
    sessionId,
    usage: estimateUsage(combinedPrompt, result),
    permissionDenials: streamJsonPermissionDenials(permissionDenials),
  }));
  const thread = await persistThreadMessages(sessionId, persistedMessages, parsed.mode, options.thread, parsed);
  notifyAgentComplete(parsed);
  return thread;
}

async function runSessionStartHandlers(plugins, sessionId) {
  await runPluginEventHandlers(plugins.handlers['session.start'], {
    thread: { id: sessionId },
  });
}

function assistantStreamContent(result, parsed = {}) {
  if (parsed.streamJsonThinking && readEffectiveSettings(parsed)['covenCode.thinking.enabled'] !== false) {
    return [{ type: 'thinking', thinking: 'Using the local deterministic recreation.' }, { type: 'text', text: result }];
  }
  return [{ type: 'text', text: result }];
}

function modelPromptWithTranscript(turnPrompt, transcript, thread, parsed = {}) {
  const context = transcript.length > 0
    ? `[conversation:${thread?.id ?? 'stream-json-input'}]\n${transcript
      .map((entry) => `user: ${entry.user}\nassistant: ${entry.assistant}`)
      .join('\n')}\n[/conversation]\n`
    : '';
  const prompt = `${context}${turnPrompt}`;
  const modelPrompt = thread ? threadContinuationPrompt(thread, prompt) : expandThreadReferences(prompt);
  return applySystemPrompt(modelPrompt, parsed);
}

function applySystemPrompt(prompt, parsed = {}) {
  const systemPrompt = readEffectiveSettings(parsed)['covenCode.systemPrompt'];
  if (typeof systemPrompt !== 'string' || systemPrompt.trim() === '') return prompt;
  return `[system]\n${systemPrompt.trim()}\n[/system]\n${prompt}`;
}

function expandAgentGuidanceReferences(expandedPrompt, parsed = {}) {
  const readFiles = filesInPrompt(expandedPrompt);
  const agentFiles = [
    ...discoverAgentFiles(process.cwd()),
    ...discoverSubtreeAgentFiles(readFiles),
  ];
  const blocks = [...new Set(agentFiles)]
    .map((filePath) => guidanceBlock(filePath, readFiles, parsed))
    .filter(Boolean);
  return blocks.join('\n');
}

function discoverSubtreeAgentFiles(readFiles) {
  const cwd = path.resolve(process.cwd());
  const files = [];
  for (const filePath of readFiles) {
    let current = path.dirname(path.resolve(filePath));
    while (current.startsWith(cwd) && current !== cwd && current !== path.dirname(current)) {
      const guidance = firstGuidanceInDir(current);
      if (guidance) files.push(guidance);
      current = path.dirname(current);
    }
  }
  return files;
}

function guidanceBlock(filePath, readFiles, parsed = {}) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const expandable = stripFencedCodeBlocks(content);
    const expanded = expandFileReferences(expandable, {
      baseDir: path.dirname(filePath),
      parsed,
      includeFile: (mentionedFile, mentionedContent) => guidanceMentionApplies(mentionedFile, mentionedContent, readFiles),
    });
    return `[agent:${filePath}]\n${expanded}\n[/agent]`;
  } catch {
    return undefined;
  }
}

function filesInPrompt(prompt) {
  return [...prompt.matchAll(/\[file:([^\]\r\n]+)\]/g)].map((match) => path.resolve(match[1]));
}

function guidanceMentionApplies(mentionedFile, content, readFiles) {
  const globs = frontmatterGlobs(content);
  if (globs.length === 0) return true;
  return readFiles.some((filePath) => globs.some((glob) => guidanceGlobMatches(glob, filePath, mentionedFile)));
}

function frontmatterGlobs(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return [];
  const frontmatter = match[1];
  const inline = frontmatter.match(/^globs:\s*\[(.*)\]\s*$/m);
  if (inline) {
    return inline[1]
      .split(',')
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  const lines = frontmatter.split(/\r?\n/);
  const globs = [];
  let inGlobs = false;
  for (const line of lines) {
    if (/^globs:\s*$/.test(line)) {
      inGlobs = true;
      continue;
    }
    if (inGlobs) {
      const entry = line.match(/^\s*-\s*(.+?)\s*$/);
      if (entry) globs.push(entry[1].replace(/^["']|["']$/g, ''));
      else if (/^\S/.test(line)) break;
    }
  }
  return globs.filter(Boolean);
}

function guidanceGlobMatches(pattern, readFile, guidanceFile) {
  const normalized = path.normalize(pattern);
  if (normalized.startsWith(`..${path.sep}`) || normalized.startsWith(`.${path.sep}`)) {
    const absolutePattern = path.resolve(path.dirname(guidanceFile), normalized);
    return globToRegex(path.normalize(absolutePattern)).test(path.normalize(readFile));
  }
  const relative = path.relative(process.cwd(), readFile);
  const candidates = normalized.startsWith(`**${path.sep}`)
    ? [normalized]
    : [normalized, `**${path.sep}${normalized}`];
  return candidates.some((candidate) => globToRegex(path.normalize(candidate)).test(path.normalize(relative)));
}

function stripFencedCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, '');
}

function combinePrompt(prompt, stdin, streamJsonInput) {
  if (streamJsonInput && stdin.trim()) {
    return streamJsonInputMessages(prompt, stdin)
      .map((message) => message.text)
      .filter(Boolean)
      .join('\n');
  }

  const processedStdin = stdin;
  if (prompt && processedStdin.trim()) return `${prompt}\n\n${processedStdin.trimEnd()}`;
  if (prompt) return prompt;
  return processedStdin.trimEnd();
}

export { UsageError };
