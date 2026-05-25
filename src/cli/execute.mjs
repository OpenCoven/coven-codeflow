import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_TOOLS, CONFIG_SUBDIR, THREAD_URL_BASE } from '../constants.mjs';
import { estimateUsage, localAgentResponse } from '../agent/local.mjs';
import {
  listActiveMcpServerEntries,
  listConfiguredMcpServers,
} from '../mcp/discover.mjs';
import { callMcpTool, discoverMcpToolRows, isMcpToolIncluded, parseMcpToolName, readMcpResource } from '../mcp/probe.mjs';
import {
  createPluginToolContext,
  listPluginTools,
  loadPlugins,
  runPluginEventHandlers,
} from '../plugins/discover.mjs';
import { discoverAgentFiles, firstGuidanceInDir } from '../commands/agents.mjs';
import {
  executeToolboxTool,
  isToolDisabled,
  listToolboxTools,
  normalizeToolName,
  parseToolUseArgs,
  toolKindForName,
} from '../tools/toolbox.mjs';
import { resolvePermissionDecision } from '../commands/permissions.mjs';
import { listThreads, persistThreadMessages, threadContinuationPrompt, threadSearchText } from '../threads/store.mjs';
import { readEffectiveSettings } from '../settings/load.mjs';
import { configDir } from '../settings/paths.mjs';
import { expandFileReferences, expandThreadReferences, imageMentionBlock } from './refs.mjs';
import { UsageError } from './parse.mjs';
import { reasoningEffortForMode } from './reasoning.mjs';
import { notifyAgentComplete } from './notifications.mjs';
import { shellQuote, splitShellWords } from '../util/shell.mjs';
import { globToRegex, walkFiles } from '../util/glob.mjs';
import { displayCwd, emitJson } from '../util/fs.mjs';

const MAX_AGENT_CONTINUATIONS = 8;
const PAINTER_PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFeAKU5XgS2wAAAABJRU5ErkJggg==',
  'base64',
);

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
    const pluginTools = await listPluginTools(process.cwd());
    const tools = [
      ...BUILTIN_TOOLS.map(([name]) => name),
      ...listToolboxTools(parsed).map((tool) => tool.name),
      ...pluginTools.map((tool) => tool.name),
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
  const toolRun = await executePromptToolRequest(prompt, stdin, sessionId, parsed);
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
  const pluginTools = await listPluginTools(process.cwd());
  const tools = [
    ...BUILTIN_TOOLS.map(([name]) => name),
    ...listToolboxTools(parsed).map((tool) => tool.name),
    ...pluginTools.map((tool) => tool.name),
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
    const toolRun = await executePromptToolRequest(input.text, '', sessionId, parsed);
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

function toolRunParent(toolRun, field, fallback) {
  return Object.hasOwn(toolRun, field) ? toolRun[field] : fallback;
}

function streamJsonTurnCount(turns = []) {
  return turns.reduce((count, turn) => count + (turn.toolRun?.toolUse ? 2 : 1), 0);
}

function streamJsonPermissionDenials(denials = []) {
  return denials.map((denial) => {
    if (typeof denial === 'string') return denial;
    const reason = denial.reason ? ` (${denial.reason})` : '';
    return `${denial.tool}: ${denial.action}${reason}`;
  });
}

function streamJsonResultMessage({ started, isError, errorSubtype, numTurns, result, sessionId, usage, permissionDenials }) {
  const common = {
    type: 'result',
    duration_ms: Date.now() - started,
    num_turns: numTurns,
    session_id: sessionId,
    usage,
    permission_denials: permissionDenials,
  };
  if (isError) {
    return {
      ...common,
      subtype: errorSubtype ?? 'error_during_execution',
      is_error: true,
      error: result,
    };
  }
  return {
    ...common,
    subtype: 'success',
    is_error: false,
    result,
  };
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

function streamJsonInputMessages(prompt, stdin) {
  const messages = [];
  let generatedImageIndex = 0;
  if (prompt) {
    messages.push({
      content: [{ type: 'text', text: prompt }],
      text: prompt,
      steer: false,
    });
  }
  for (const [index, line] of stdin.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new UsageError(`stream-json-input line ${index + 1} is not valid JSON`);
    }
    if (event.type !== 'user') continue;
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    messages.push({
      content,
      text: content
        .map((block) => streamJsonContentBlockText(block, () => {
          generatedImageIndex += 1;
          return generatedImageIndex;
        }))
        .filter(Boolean)
        .join('\n'),
      steer: event.steer === true,
    });
  }
  if (messages.length === 0) {
    messages.push({ content: [{ type: 'text', text: '' }], text: '', steer: false });
  }
  return messages;
}

function streamJsonContentBlockText(block, nextGeneratedImageIndex = () => 1) {
  if (block.type === 'text') return block.text;
  if (block.type !== 'image') return undefined;
  const base64Image = validateStreamJsonBase64Image(block.source);
  if (block.source_path) {
    const filePath = block.source_path.startsWith('file://')
      ? fileURLToPath(block.source_path)
      : block.source_path;
    return imageMentionBlock(filePath);
  }
  if (base64Image) {
    const sourcePath = `stream-json-input-image-${nextGeneratedImageIndex()}.${imageMediaTypeExtension(base64Image.mediaType)}`;
    return `[image:${sourcePath}]\nmedia_type: ${base64Image.mediaType}\nbytes: ${base64Image.bytes}\n[/image]`;
  }
  return undefined;
}

function validateStreamJsonBase64Image(source) {
  if (source?.type !== 'base64' || !source.media_type || !source.data) return undefined;
  const raw = Buffer.from(source.data, 'base64');
  const detected = detectImageMediaType(raw);
  if (detected && detected !== source.media_type) {
    throw new UsageError(`stream-json-input image media_type ${source.media_type} does not match decoded ${detected}`);
  }
  if (!detected) throw new UsageError(`stream-json-input image media_type ${source.media_type} is not supported by decoded image data`);
  return { mediaType: source.media_type, bytes: raw.byteLength };
}

function streamJsonOutputUserContent(content = []) {
  const textBlocks = content.filter((block) => block.type === 'text');
  return textBlocks.length > 0 ? textBlocks : [{ type: 'text', text: '' }];
}

function detectImageMediaType(raw) {
  if (raw.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) return 'image/jpeg';
  const header = raw.subarray(0, 12).toString('ascii');
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

function imageMediaTypeExtension(mediaType) {
  if (mediaType === 'image/jpeg') return 'jpg';
  return mediaType.split('/').at(-1) || 'img';
}

async function executePromptToolRequest(prompt, stdin, threadId, parsed = {}) {
  const request = parsePromptToolRequest(prompt);
  if (!request) return undefined;
  const plugins = await loadPlugins(process.cwd());
  if (request.toolName.startsWith('mcp__')) return executePromptMcpToolRequest(request, parsed, threadId, plugins);
  if (request.toolName === 'Bash') return executePromptBashToolRequest(request, stdin, parsed, plugins, threadId);
  if (request.toolName === 'Read') return executePromptReadToolRequest(request, parsed, plugins, threadId);
  if (request.toolName === 'Grep') return executePromptGrepToolRequest(request, parsed, plugins, threadId);
  if (request.toolName === 'glob') return executePromptGlobToolRequest(request, parsed, plugins, threadId);
  if (request.toolName === 'create_file') return executePromptCreateFileToolRequest(request, parsed, plugins, threadId);
  if (request.toolName === 'edit_file') return executePromptEditFileToolRequest(request, parsed, plugins, threadId);
  if (request.toolName === 'undo_edit') return executePromptUndoEditToolRequest(request, parsed, plugins, threadId);
  if (request.toolName === 'Task') return executePromptTaskToolRequest(request, parsed, plugins, threadId);
  if (request.toolName === 'oracle') return executePromptOracleToolRequest(request, parsed, plugins, threadId);
  if (request.toolName === 'librarian') return executePromptLibrarianToolRequest(request, parsed, plugins, threadId);
  if (request.toolName === 'painter') return executePromptPainterToolRequest(request, parsed, plugins, threadId);
  if (request.toolName === 'mermaid') return executePromptMermaidToolRequest(request, parsed, plugins, threadId);
  if (request.toolName === 'look_at') return executePromptLookAtToolRequest(request, parsed, plugins, threadId);
  if (request.toolName === 'web_search') return executePromptWebSearchToolRequest(request, parsed, plugins, threadId);
  if (request.toolName === 'read_web_page') return executePromptReadWebPageToolRequest(request, parsed, plugins, threadId);
  if (request.toolName === 'find_thread') return executePromptFinderToolRequest(request, parsed, plugins, threadId, 'find_thread');
  if (request.toolName === 'finder') return executePromptFinderToolRequest(request, parsed, plugins, threadId);
  if (request.toolName === 'read_mcp_resource') return executePromptReadMcpResourceToolRequest(request, parsed, plugins, threadId);
  const pluginTool = plugins.tools.find((entry) => entry.name === request.toolName);
  if (pluginTool) return executePromptPluginToolRequest(pluginTool, request, parsed, plugins, threadId);
  const toolboxName = normalizeToolName(request.toolName);
  const tool = listToolboxTools(parsed).find((entry) => entry.name === toolboxName);
  if (!tool) return { output: `Unknown tool: ${request.toolName}` };
  if (isToolDisabled(tool.name, 'toolbox', parsed)) return { output: `Tool disabled: ${tool.name}` };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(tool.name, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(tool.name, request, callDecision);
  if (callResult.output) {
    return {
      ...callResult.output,
      toolUse: pluginToolUseBlock(tool.name, request.flags, toolUseID),
    };
  }
  request.flags = callResult.request.flags;
  const decision = resolvePermissionDecision(tool.name, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(tool.name, decision),
      permissionDenials: [{ tool: tool.name, action: decision.action, reason: 'permission' }],
    };
  }
  const result = executeToolboxTool(tool, request.flags, stdin, threadId);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 0;
  const output = result.stdout.trimEnd();
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(tool.name, request.flags, (result.status ?? 0) === 0 ? 'done' : 'error', output, threadId, toolUseID),
  );
  const finalOutput = pluginResultOutput(resultDecision, output);
  const exitCode = pluginToolResultDecisionExitCode(resultDecision, result.status ?? 0);
  return {
    output: finalOutput,
    exitCode,
    toolUse: pluginToolUseBlock(tool.name, request.flags, toolUseID),
  };
}

function parsePromptToolRequest(prompt) {
  const match = prompt.match(/\b(?:use|run|call)\s+([A-Za-z0-9_-]+(?:__[A-Za-z0-9_-]+)?)([^\r\n]*)/i);
  if (!match) return undefined;
  const useArgs = parseToolUseArgs([match[1], ...splitShellWords(match[2] ?? '')]);
  return { toolName: useArgs.toolName, flags: useArgs.flags };
}

function createToolUseID() {
  return `toolu_${randomUUID()}`;
}

function pluginToolCallEvent(tool, input, threadId, toolUseID = createToolUseID()) {
  return {
    toolUseID,
    tool,
    input,
    thread: { id: threadId },
  };
}

function pluginToolResultEvent(tool, input, status, output, threadId, toolUseID, error) {
  return {
    toolUseID,
    tool,
    input,
    status,
    output,
    ...(error ? { error } : {}),
    thread: { id: threadId },
  };
}

function pluginToolUseBlock(tool, input, toolUseID) {
  return {
    type: 'tool_use',
    id: toolUseID,
    name: tool,
    input,
  };
}

async function executePromptPluginToolRequest(tool, request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled(tool.name, 'plugin', parsed)) return { output: `Tool disabled: ${tool.name}` };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(tool.name, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(tool.name, request, callDecision);
  if (callResult.output) {
    return {
      ...callResult.output,
      toolUse: pluginToolUseBlock(tool.name, request.flags, toolUseID),
    };
  }
  request = callResult.request;
  const decision = resolvePermissionDecision(tool.name, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(tool.name, decision),
      permissionDenials: [{ tool: tool.name, action: decision.action, reason: 'permission' }],
    };
  }
  const output = typeof tool.execute === 'function' ? await tool.execute(request.flags, createPluginToolContext()) : undefined;
  const normalizedOutput = normalizePluginToolExecuteOutput(output);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(tool.name, request.flags, 'done', normalizedOutput.raw, threadId, toolUseID),
  );
  const finalOutput = normalizePluginToolOutput(
    pluginToolResultDecisionOutput(resultDecision, normalizedOutput.raw),
  );
  const exitCode = pluginToolResultDecisionExitCode(resultDecision);
  return {
    output: finalOutput.text,
    toolResultOutput: finalOutput.raw,
    exitCode,
    toolUse: pluginToolUseBlock(tool.name, request.flags, toolUseID),
  };
}

function pluginToolResultDecisionOutput(resultDecision = {}, fallback) {
  validateToolResultDecision(resultDecision);
  if (resultDecision.status === 'error') {
    return resultDecision.error ?? resultDecision.output ?? fallback;
  }
  if (resultDecision.status === 'cancelled') {
    return resultDecision.error ?? resultDecision.output ?? 'Tool cancelled';
  }
  return resultDecision.output !== undefined ? resultDecision.output : fallback;
}

function pluginToolResultDecisionExitCode(resultDecision = {}, fallback = 0) {
  validateToolResultDecision(resultDecision);
  if (resultDecision.status === 'error' || resultDecision.status === 'cancelled') return 1;
  if (resultDecision.status === 'done') return 0;
  return fallback;
}

function validateToolResultDecision(resultDecision = {}) {
  if (!resultDecision || typeof resultDecision !== 'object' || !Object.hasOwn(resultDecision, 'status')) return;
  if (resultDecision.status !== 'done' && resultDecision.status !== 'error' && resultDecision.status !== 'cancelled') {
    throw new Error('plugin tool.result status must be done, error, or cancelled');
  }
  const allowedKeys = resultDecision.status === 'done' ? ['output', 'status'] : ['error', 'output', 'status'];
  if (Object.keys(resultDecision).some((key) => !allowedKeys.includes(key))) {
    throw new Error('plugin tool.result fields must match the documented union');
  }
  if (
    (resultDecision.status === 'error' || resultDecision.status === 'cancelled') &&
    resultDecision.error !== undefined &&
    typeof resultDecision.error !== 'string'
  ) {
    throw new Error('plugin tool.result error must be a string');
  }
}

function toolResultContent(toolRun = {}) {
  return Object.hasOwn(toolRun, 'toolResultOutput') ? toolRun.toolResultOutput : toolRun.output;
}

function normalizePluginToolOutput(output) {
  if (Array.isArray(output) && output.every(isPluginContentBlock)) {
    const text = output.map(pluginContentBlockText).filter(Boolean).join('\n').trimEnd();
    return {
      raw: output,
      text,
    };
  }
  const text = String(output ?? '').trimEnd();
  return {
    raw: text,
    text,
  };
}

function normalizePluginToolExecuteOutput(output) {
  if (output === undefined || typeof output === 'string') return normalizePluginToolOutput(output);
  if (Array.isArray(output)) {
    if (!output.every(isPluginContentBlock)) {
      throw new Error('plugin tool result content blocks must be text or image blocks');
    }
    return normalizePluginToolOutput(output);
  }
  throw new Error('plugin tool result must be a string, content blocks, or undefined');
}

function isPluginContentBlock(block) {
  if (!block || typeof block !== 'object') return false;
  if (block.type === 'text') return typeof block.text === 'string';
  if (block.type === 'image') return typeof block.mimeType === 'string' && typeof block.data === 'string';
  return false;
}

function pluginContentBlockText(block) {
  if (block.type === 'text') return block.text;
  return '';
}

function applyToolCallDecision(toolName, request, callDecision = { action: 'allow' }) {
  validateToolCallDecision(callDecision);
  if (callDecision.action === 'allow') return { request };
  if (callDecision.action === 'reject-and-continue') {
    if (typeof callDecision.message !== 'string') {
      throw new Error('plugin tool.call reject-and-continue message must be a string');
    }
    return {
      output: {
        output: callDecision.message,
        exitCode: 0,
      },
    };
  }
  if (callDecision.action === 'synthesize') {
    const result = callDecision.result && isPlainObject(callDecision.result)
      ? callDecision.result
      : callDecision;
    if (typeof result.output !== 'string') {
      throw new Error('plugin tool.call synthesize result.output must be a string');
    }
    if (result.exitCode !== undefined && !Number.isInteger(result.exitCode)) {
      throw new Error('plugin tool.call synthesize result.exitCode must be an integer');
    }
    return {
      output: {
        output: result.output.trimEnd(),
        exitCode: result.exitCode ?? 0,
      },
    };
  }
  if (callDecision.action === 'error') {
    if (typeof callDecision.message !== 'string') {
      throw new Error('plugin tool.call error message must be a string');
    }
    return {
      output: {
        output: callDecision.message,
        exitCode: 1,
      },
    };
  }
  if (callDecision.action === 'modify') {
    if (!isPlainObject(callDecision.input)) {
      throw new Error('plugin tool.call modify input must be an object');
    }
    return { request: { ...request, flags: callDecision.input } };
  }
  return { request };
}

function validateToolCallDecision(callDecision) {
  if (!callDecision || typeof callDecision !== 'object') {
    throw new Error('plugin tool.call result must be an object');
  }
  if (
    callDecision.action !== 'allow' &&
    callDecision.action !== 'reject-and-continue' &&
    callDecision.action !== 'modify' &&
    callDecision.action !== 'synthesize' &&
    callDecision.action !== 'error'
  ) {
    throw new Error('plugin tool.call action must be allow, reject-and-continue, modify, synthesize, or error');
  }
  const allowedKeys = {
    allow: ['action'],
    'reject-and-continue': ['action', 'message'],
    modify: ['action', 'input'],
    synthesize: ['action', 'result'],
    error: ['action', 'message'],
  }[callDecision.action];
  if (Object.keys(callDecision).some((key) => !allowedKeys.includes(key))) {
    throw new Error('plugin tool.call fields must match the documented union');
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toolCallDecisionToolRun(toolName, input, toolUseID, callResult) {
  return {
    ...callResult.output,
    toolUse: pluginToolUseBlock(toolName, input, toolUseID),
  };
}

async function executePromptBashToolRequest(request, stdin = '', parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled('Bash', 'built-in', parsed)) return { output: 'Tool disabled: Bash' };
  request = { ...request, flags: normalizeBashInput(request.flags) };
  if (!request.flags.command) return { output: 'Bash requires --command' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent('Bash', request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision('Bash', request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun('Bash', request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeBashInput(callResult.request.flags) };
  const decision = resolvePermissionDecision('Bash', request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput('Bash', decision),
      permissionDenials: [{ tool: 'Bash', action: decision.action, reason: 'permission' }],
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
    pluginToolResultEvent('Bash', request.flags, (result.status ?? 0) === 0 ? 'done' : 'error', output, threadId, toolUseID),
  );
  const exitCode = pluginToolResultDecisionExitCode(resultDecision, result.status ?? 0);
  return {
    output: pluginResultOutput(resultDecision, output),
    exitCode,
    toolUse: pluginToolUseBlock('Bash', request.flags, toolUseID),
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

async function executePromptReadToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled('Read', 'built-in', parsed)) return { output: 'Tool disabled: Read' };
  request = { ...request, flags: normalizeReadInput(request.flags) };
  if (!request.flags.path) return { output: 'Read requires --path' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent('Read', request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision('Read', request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun('Read', request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeReadInput(callResult.request.flags) };
  const decision = resolvePermissionDecision('Read', request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput('Read', decision),
      permissionDenials: [{ tool: 'Read', action: decision.action, reason: 'permission' }],
    };
  }
  const output = readBuiltinFile(request.flags.path).trimEnd();
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent('Read', request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock('Read', request.flags, toolUseID),
  };
}

function normalizeReadInput(input = {}) {
  const filePath = input.path ?? input.file ?? input.file_path;
  return { ...input, path: filePath ? String(filePath) : '' };
}

function readBuiltinFile(filePath) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  return readFileSync(absolutePath, 'utf8');
}

async function executePromptGrepToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled('Grep', 'built-in', parsed)) return { output: 'Tool disabled: Grep' };
  request = { ...request, flags: normalizeGrepInput(request.flags) };
  if (!request.flags.pattern) return { output: 'Grep requires --pattern' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent('Grep', request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision('Grep', request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun('Grep', request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeGrepInput(callResult.request.flags) };
  const decision = resolvePermissionDecision('Grep', request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput('Grep', decision),
      permissionDenials: [{ tool: 'Grep', action: decision.action, reason: 'permission' }],
    };
  }
  const output = grepBuiltinFiles(request.flags.pattern, request.flags.path);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent('Grep', request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock('Grep', request.flags, toolUseID),
  };
}

function normalizeGrepInput(input = {}) {
  const pattern = input.pattern ?? input.regex ?? input.query;
  const searchPath = input.path ?? input.dir ?? input.cwd ?? '.';
  return {
    ...input,
    pattern: pattern ? String(pattern) : '',
    path: searchPath ? String(searchPath) : '.',
  };
}

function grepBuiltinFiles(pattern, searchPath = '.') {
  const root = path.isAbsolute(searchPath) ? searchPath : path.resolve(process.cwd(), searchPath);
  const files = walkFiles(root).sort();
  const re = new RegExp(pattern);
  const matches = [];
  for (const filePath of files) {
    let content = '';
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!re.test(lines[index])) continue;
      matches.push(`${relativeToolPath(filePath)}:${index + 1}:${lines[index]}`);
    }
  }
  return matches.join('\n');
}

function relativeToolPath(filePath) {
  const relative = path.relative(process.cwd(), filePath);
  return relative && !relative.startsWith('..') ? relative : filePath;
}

async function executePromptGlobToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled('glob', 'built-in', parsed)) return { output: 'Tool disabled: glob' };
  request = { ...request, flags: normalizeGlobInput(request.flags) };
  if (!request.flags.pattern) return { output: 'glob requires --pattern' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent('glob', request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision('glob', request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun('glob', request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeGlobInput(callResult.request.flags) };
  const decision = resolvePermissionDecision('glob', request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput('glob', decision),
      permissionDenials: [{ tool: 'glob', action: decision.action, reason: 'permission' }],
    };
  }
  const output = globBuiltinFiles(request.flags.pattern, request.flags.path);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent('glob', request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock('glob', request.flags, toolUseID),
  };
}

function normalizeGlobInput(input = {}) {
  const pattern = input.pattern ?? input.glob ?? input.query;
  const searchPath = input.path ?? input.dir ?? input.cwd ?? '.';
  return {
    ...input,
    pattern: pattern ? String(pattern) : '',
    path: searchPath ? String(searchPath) : '.',
  };
}

function globBuiltinFiles(pattern, searchPath = '.') {
  const root = path.isAbsolute(searchPath) ? searchPath : path.resolve(process.cwd(), searchPath);
  const absolutePattern = path.isAbsolute(pattern) ? path.normalize(pattern) : path.normalize(path.join(root, pattern));
  const matchers = [globToRegex(absolutePattern)];
  if (!path.isAbsolute(pattern) && pattern.startsWith('**/')) {
    matchers.push(globToRegex(path.normalize(path.join(root, pattern.slice('**/'.length)))));
  }
  return walkFiles(root)
    .filter((filePath) => matchers.some((matcher) => matcher.test(path.normalize(filePath))))
    .map(relativeToolPath)
    .sort()
    .join('\n');
}

async function executePromptCreateFileToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled('create_file', 'built-in', parsed)) return { output: 'Tool disabled: create_file' };
  request = { ...request, flags: normalizeCreateFileInput(request.flags) };
  if (!request.flags.path) return { output: 'create_file requires --path' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent('create_file', request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision('create_file', request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun('create_file', request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeCreateFileInput(callResult.request.flags) };
  const decision = resolvePermissionDecision('create_file', request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput('create_file', decision),
      permissionDenials: [{ tool: 'create_file', action: decision.action, reason: 'permission' }],
    };
  }
  const output = createBuiltinFile(request.flags.path, request.flags.content);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent('create_file', request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock('create_file', request.flags, toolUseID),
  };
}

function normalizeCreateFileInput(input = {}) {
  const filePath = input.path ?? input.file ?? input.file_path;
  const content = input.content ?? input.text ?? input.body ?? '';
  return {
    ...input,
    path: filePath ? String(filePath) : '',
    content: String(content ?? ''),
  };
}

function createBuiltinFile(filePath, content) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, { encoding: 'utf8', flag: 'wx' });
  return `Created ${filePath}`;
}

async function executePromptEditFileToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled('edit_file', 'built-in', parsed)) return { output: 'Tool disabled: edit_file' };
  request = { ...request, flags: normalizeEditFileInput(request.flags) };
  if (!request.flags.path) return { output: 'edit_file requires --path' };
  if (!request.flags.old_string) return { output: 'edit_file requires --old' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent('edit_file', request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision('edit_file', request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun('edit_file', request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeEditFileInput(callResult.request.flags) };
  const decision = resolvePermissionDecision('edit_file', request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput('edit_file', decision),
      permissionDenials: [{ tool: 'edit_file', action: decision.action, reason: 'permission' }],
    };
  }
  const editResult = editBuiltinFile(request.flags.path, request.flags.old_string, request.flags.new_string, threadId);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent('edit_file', request.flags, editResult.status, editResult.output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, editResult.output, editResult.status === 'done' ? 0 : 1),
    toolUse: pluginToolUseBlock('edit_file', request.flags, toolUseID),
  };
}

function normalizeEditFileInput(input = {}) {
  const filePath = input.path ?? input.file ?? input.file_path;
  const oldString = input.old_string ?? input.old ?? input.search ?? input.find;
  const newString = input.new_string ?? input.new ?? input.replacement ?? input.replace ?? '';
  return {
    ...input,
    path: filePath ? String(filePath) : '',
    old: oldString ? String(oldString) : '',
    new: String(newString ?? ''),
    old_string: oldString ? String(oldString) : '',
    new_string: String(newString ?? ''),
  };
}

function editBuiltinFile(filePath, oldString, newString, threadId = '') {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const current = readFileSync(absolutePath, 'utf8');
  if (!current.includes(oldString)) {
    return { status: 'error', output: `No match found in ${filePath}` };
  }
  recordEditUndo(threadId, { path: filePath, absolutePath, content: current });
  writeFileSync(absolutePath, current.replace(oldString, newString), 'utf8');
  return { status: 'done', output: `Edited ${filePath}` };
}

async function executePromptUndoEditToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled('undo_edit', 'built-in', parsed)) return { output: 'Tool disabled: undo_edit' };
  request = { ...request, flags: normalizeUndoEditInput(request.flags) };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent('undo_edit', request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision('undo_edit', request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun('undo_edit', request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeUndoEditInput(callResult.request.flags) };
  const decision = resolvePermissionDecision('undo_edit', request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput('undo_edit', decision),
      permissionDenials: [{ tool: 'undo_edit', action: decision.action, reason: 'permission' }],
    };
  }
  const undoResult = undoBuiltinEdit(threadId, request.flags.path);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent('undo_edit', request.flags, undoResult.status, undoResult.output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, undoResult.output, undoResult.status === 'done' ? 0 : 1),
    toolUse: pluginToolUseBlock('undo_edit', request.flags, toolUseID),
  };
}

function normalizeUndoEditInput(input = {}) {
  const filePath = input.path ?? input.file ?? input.file_path;
  return {
    ...input,
    path: filePath ? String(filePath) : '',
  };
}

function recordEditUndo(threadId, entry) {
  const entries = readEditUndoEntries(threadId);
  const filePath = editUndoFile(threadId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify([...entries, { ...entry, createdAt: new Date().toISOString() }], null, 2)}\n`);
}

function undoBuiltinEdit(threadId, filePath = '') {
  const entries = readEditUndoEntries(threadId);
  const absolutePath = filePath ? path.resolve(process.cwd(), filePath) : '';
  const index = findUndoEntryIndex(entries, filePath, absolutePath);
  if (index === -1) return { status: 'error', output: filePath ? `No edit to undo for ${filePath}` : 'No edit to undo' };
  const [entry] = entries.splice(index, 1);
  writeFileSync(entry.absolutePath, entry.content, 'utf8');
  writeFileSync(editUndoFile(threadId), `${JSON.stringify(entries, null, 2)}\n`);
  return { status: 'done', output: `Undid edit to ${entry.path}` };
}

function findUndoEntryIndex(entries, filePath, absolutePath) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!filePath || entry.path === filePath || entry.absolutePath === absolutePath) return index;
  }
  return -1;
}

function readEditUndoEntries(threadId) {
  try {
    const parsed = JSON.parse(readFileSync(editUndoFile(threadId), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function editUndoFile(threadId) {
  return path.join(configDir(), CONFIG_SUBDIR, 'undo', `${threadId || 'global'}.json`);
}

async function executePromptTaskToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled('Task', 'built-in', parsed)) return { output: 'Tool disabled: Task' };
  request = { ...request, flags: normalizeTaskInput(request.flags) };
  if (!request.flags.prompt) return { output: 'Task requires --prompt' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent('Task', request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision('Task', request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun('Task', request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeTaskInput(callResult.request.flags) };
  const decision = resolvePermissionDecision('Task', request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput('Task', decision),
      permissionDenials: [{ tool: 'Task', action: decision.action, reason: 'permission' }],
    };
  }
  const output = localAgentResponse(request.flags.prompt, '');
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent('Task', request.flags, 'done', output, threadId, toolUseID),
  );
  const finalResult = pluginTextToolRunResult(resultDecision, output);
  return {
    output: finalResult.output,
    exitCode: finalResult.exitCode,
    subagentMessages: [{ text: finalResult.output }],
    toolResultParentToolUseId: null,
    finalParentToolUseId: null,
    toolUse: pluginToolUseBlock('Task', request.flags, toolUseID),
  };
}

function normalizeTaskInput(input = {}) {
  const prompt = input.prompt ?? input.task ?? input.instructions ?? input.message;
  const description = input.description ?? input.title ?? input.name ?? 'subagent task';
  return {
    ...input,
    description: String(description ?? 'subagent task'),
    prompt: prompt ? String(prompt) : '',
  };
}

async function executePromptOracleToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled('oracle', 'built-in', parsed)) return { output: 'Tool disabled: oracle' };
  request = { ...request, flags: normalizeOracleInput(request.flags) };
  if (!request.flags.prompt) return { output: 'oracle requires --prompt' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent('oracle', request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision('oracle', request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun('oracle', request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeOracleInput(callResult.request.flags) };
  const decision = resolvePermissionDecision('oracle', request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput('oracle', decision),
      permissionDenials: [{ tool: 'oracle', action: decision.action, reason: 'permission' }],
    };
  }
  const output = `Oracle: ${localAgentResponse(request.flags.prompt, '')}`;
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent('oracle', request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock('oracle', request.flags, toolUseID),
  };
}

function normalizeOracleInput(input = {}) {
  const prompt = input.prompt ?? input.question ?? input.query ?? input.message;
  return {
    ...input,
    prompt: prompt ? String(prompt) : '',
  };
}

async function executePromptLibrarianToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled('librarian', 'built-in', parsed)) return { output: 'Tool disabled: librarian' };
  request = { ...request, flags: normalizeLibrarianInput(request.flags) };
  if (!request.flags.query) return { output: 'librarian requires --query' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent('librarian', request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision('librarian', request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun('librarian', request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeLibrarianInput(callResult.request.flags) };
  const decision = resolvePermissionDecision('librarian', request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput('librarian', decision),
      permissionDenials: [{ tool: 'librarian', action: decision.action, reason: 'permission' }],
    };
  }
  const output = searchWorkspaceForLibrarian(request.flags);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent('librarian', request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock('librarian', request.flags, toolUseID),
  };
}

function normalizeLibrarianInput(input = {}) {
  const query = input.query ?? input.q ?? input.prompt ?? input.question ?? input.topic;
  const limit = Number.parseInt(String(input.limit ?? 5), 10);
  return {
    ...input,
    query: query ? String(query) : '',
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 20) : 5,
  };
}

function searchWorkspaceForLibrarian(input) {
  const matches = findWorkspaceTextMatches(input.query, input.limit);
  return [
    `Librarian search: ${input.query}`,
    'scope: current workspace',
    'matches:',
    ...(matches.length ? matches.map(formatLibrarianMatch) : ['- no local matches found']),
  ].join('\n');
}

function findWorkspaceTextMatches(query, limit) {
  const needle = query.toLowerCase();
  const root = process.cwd();
  return walkFiles(root)
    .map((filePath) => path.relative(root, filePath))
    .filter((relativePath) => !relativePath.split(path.sep).some((part) => part === '.git' || part === 'node_modules'))
    .sort()
    .flatMap((relativePath) => {
      let text;
      try {
        text = readFileSync(path.join(root, relativePath), 'utf8');
      } catch {
        return [];
      }
      return text.split(/\r?\n/).flatMap((line, index) => (
        line.toLowerCase().includes(needle)
          ? [{ path: relativePath, line: index + 1, text: line.trim() }]
          : []
      ));
    })
    .slice(0, limit);
}

function formatLibrarianMatch(match) {
  return `- ${match.path}:${match.line}: ${match.text}`;
}

async function executePromptPainterToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled('painter', 'built-in', parsed)) return { output: 'Tool disabled: painter' };
  request = { ...request, flags: normalizePainterInput(request.flags) };
  if (!request.flags.prompt) return { output: 'painter requires --prompt' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent('painter', request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision('painter', request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun('painter', request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizePainterInput(callResult.request.flags) };
  const decision = resolvePermissionDecision('painter', request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput('painter', decision),
      permissionDenials: [{ tool: 'painter', action: decision.action, reason: 'permission' }],
    };
  }
  const output = writePainterArtifact(request.flags);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent('painter', request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock('painter', request.flags, toolUseID),
  };
}

function normalizePainterInput(input = {}) {
  const prompt = input.prompt ?? input.description ?? input.text ?? '';
  const output = input.output ?? input.path ?? input.file ?? 'coven-code-painter-output.png';
  const references = [input.reference, input.references, input.image, input.images]
    .flat()
    .filter(Boolean)
    .map(String);
  return {
    ...input,
    prompt: String(prompt),
    output: String(output),
    references,
  };
}

function writePainterArtifact(input) {
  const outputPath = path.resolve(process.cwd(), input.output);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, PAINTER_PLACEHOLDER_PNG);
  return [
    `Generated image: ${input.output}`,
    'media_type: image/png',
    `prompt: ${input.prompt}`,
    ...(input.references.length ? [`references: ${input.references.join(', ')}`] : []),
  ].join('\n');
}

async function executePromptMermaidToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled('mermaid', 'built-in', parsed)) return { output: 'Tool disabled: mermaid' };
  request = { ...request, flags: normalizeMermaidInput(request.flags) };
  if (!request.flags.code) return { output: 'mermaid requires --code' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent('mermaid', request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision('mermaid', request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun('mermaid', request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeMermaidInput(callResult.request.flags) };
  const decision = resolvePermissionDecision('mermaid', request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput('mermaid', decision),
      permissionDenials: [{ tool: 'mermaid', action: decision.action, reason: 'permission' }],
    };
  }
  const output = mermaidOutput(request.flags.code);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent('mermaid', request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock('mermaid', request.flags, toolUseID),
  };
}

function normalizeMermaidInput(input = {}) {
  const code = input.code ?? input.diagram ?? input.mermaid ?? input.source;
  return {
    ...input,
    code: code ? String(code) : '',
  };
}

function mermaidOutput(code) {
  return `\`\`\`mermaid\n${String(code).trim()}\n\`\`\``;
}

async function executePromptLookAtToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled('look_at', 'built-in', parsed)) return { output: 'Tool disabled: look_at' };
  request = { ...request, flags: normalizeLookAtInput(request.flags) };
  if (!request.flags.path) return { output: 'look_at requires --path' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent('look_at', request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision('look_at', request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun('look_at', request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeLookAtInput(callResult.request.flags) };
  const decision = resolvePermissionDecision('look_at', request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput('look_at', decision),
      permissionDenials: [{ tool: 'look_at', action: decision.action, reason: 'permission' }],
    };
  }
  const output = inspectLookAtMedia(request.flags);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent('look_at', request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock('look_at', request.flags, toolUseID),
  };
}

function normalizeLookAtInput(input = {}) {
  const source = input.path ?? input.file ?? input.image ?? input.pdf ?? input.url;
  const goal = input.goal ?? input.prompt ?? input.instructions ?? input.question ?? '';
  return {
    ...input,
    path: source ? String(source) : '',
    goal: String(goal),
  };
}

function inspectLookAtMedia(input) {
  try {
    const resolved = resolveLookAtPath(input.path);
    const raw = readFileSync(resolved);
    return formatLookAtMediaResult(input.path, raw, input.goal);
  } catch (error) {
    return `Unable to look at ${input.path}: ${error.message}`;
  }
}

function resolveLookAtPath(source) {
  if (source.startsWith('file://')) return fileURLToPath(source);
  return path.resolve(process.cwd(), source);
}

function formatLookAtMediaResult(source, raw, goal) {
  return [
    `Looked at: ${source}`,
    `media_type: ${detectLookAtMediaType(raw)}`,
    `bytes: ${raw.length}`,
    `goal: ${goal || '(none)'}`,
  ].join('\n');
}

function detectLookAtMediaType(raw) {
  const imageType = detectImageMediaType(raw);
  if (imageType) return imageType;
  if (raw.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return 'application/octet-stream';
}

async function executePromptWebSearchToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled('web_search', 'built-in', parsed)) return { output: 'Tool disabled: web_search' };
  request = { ...request, flags: normalizeWebSearchInput(request.flags) };
  if (!request.flags.query) return { output: 'web_search requires --query' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent('web_search', request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision('web_search', request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun('web_search', request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeWebSearchInput(callResult.request.flags) };
  const decision = resolvePermissionDecision('web_search', request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput('web_search', decision),
      permissionDenials: [{ tool: 'web_search', action: decision.action, reason: 'permission' }],
    };
  }
  const output = await searchWebBuiltin(request.flags.query, request.flags.limit);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent('web_search', request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock('web_search', request.flags, toolUseID),
  };
}

function normalizeWebSearchInput(input = {}) {
  const query = input.query ?? input.q ?? input.search;
  const limit = Number.parseInt(String(input.limit ?? input.count ?? 5), 10);
  return {
    ...input,
    query: query ? String(query) : '',
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 10) : 5,
  };
}

async function searchWebBuiltin(query, limit = 5) {
  const fixture = webSearchFixtureResults(limit);
  if (fixture) return formatWebSearchResults(fixture, query);

  try {
    const url = `https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query }).toString()}`;
    const response = await fetch(url, {
      headers: { 'user-agent': 'coven-code/0.0.0' },
    });
    if (!response.ok) return `Web search failed for ${query}: HTTP ${response.status}`;
    const results = parseDuckDuckGoHtml(await response.text()).slice(0, limit);
    return formatWebSearchResults(results, query);
  } catch (error) {
    return `Web search failed for ${query}: ${error.message}`;
  }
}

function webSearchFixtureResults(limit) {
  const fixtureJson = process.env.COVEN_CODE_WEB_SEARCH_RESULTS_JSON;
  if (!fixtureJson) return undefined;
  try {
    const parsed = JSON.parse(fixtureJson);
    return Array.isArray(parsed) ? parsed.slice(0, limit) : [];
  } catch {
    return [];
  }
}

function parseDuckDuckGoHtml(html) {
  const blocks = html.match(/<div[^>]+class="[^"]*result[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*result[^"]*"|<\/body>)/g) ?? [];
  return blocks
    .map((block) => {
      const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!link) return undefined;
      const snippet = block.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/)
        ?? block.match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      return {
        title: cleanHtmlText(link[2]),
        url: cleanDuckDuckGoUrl(decodeHtmlText(link[1])),
        snippet: snippet ? cleanHtmlText(snippet[1]) : '',
      };
    })
    .filter(Boolean);
}

function cleanDuckDuckGoUrl(url) {
  try {
    const parsed = new URL(url);
    const redirected = parsed.searchParams.get('uddg');
    return redirected ? decodeURIComponent(redirected) : url;
  } catch {
    return url;
  }
}

function cleanHtmlText(value = '') {
  return decodeHtmlText(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decodeHtmlText(value = '') {
  return value
    .replace(new RegExp('&' + 'a' + 'mp;', 'g'), '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function formatWebSearchResults(results = [], query = '') {
  if (results.length === 0) return `No web search results found for ${query}`;
  return results
    .map((result, index) => [
      `${index + 1}. ${result.title ?? 'Untitled'}`,
      result.url ?? '',
      result.snippet ?? '',
    ].filter(Boolean).join('\n'))
    .join('\n\n');
}

async function executePromptReadWebPageToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled('read_web_page', 'built-in', parsed)) return { output: 'Tool disabled: read_web_page' };
  request = { ...request, flags: normalizeReadWebPageInput(request.flags) };
  if (!request.flags.url) return { output: 'read_web_page requires --url' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent('read_web_page', request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision('read_web_page', request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun('read_web_page', request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeReadWebPageInput(callResult.request.flags) };
  const decision = resolvePermissionDecision('read_web_page', request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput('read_web_page', decision),
      permissionDenials: [{ tool: 'read_web_page', action: decision.action, reason: 'permission' }],
    };
  }
  const output = await readWebPageBuiltin(request.flags.url);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent('read_web_page', request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock('read_web_page', request.flags, toolUseID),
  };
}

function normalizeReadWebPageInput(input = {}) {
  const url = input.url ?? input.uri ?? input.href;
  return {
    ...input,
    url: url ? String(url) : '',
  };
}

async function readWebPageBuiltin(url) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'coven-code/0.0.0' },
    });
    if (!response.ok) return `Failed to read ${url}: HTTP ${response.status}`;
    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();
    return contentType.includes('html') || body.includes('<')
      ? htmlToText(body)
      : body.trimEnd();
  } catch (error) {
    return `Failed to read ${url}: ${error.message}`;
  }
}

function htmlToText(html) {
  return decodeHtmlText(html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(?:h[1-6]|p|div|main|article|section|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
}

async function executePromptFinderToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '', toolName = 'finder') {
  if (isToolDisabled(toolName, 'built-in', parsed)) return { output: `Tool disabled: ${toolName}` };
  request = { ...request, flags: normalizeFinderInput(request.flags) };
  if (!request.flags.query) return { output: `${toolName} requires --query` };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(toolName, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(toolName, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(toolName, request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeFinderInput(callResult.request.flags) };
  const decision = resolvePermissionDecision(toolName, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(toolName, decision),
      permissionDenials: [{ tool: toolName, action: decision.action, reason: 'permission' }],
    };
  }
  const output = findThreadsBuiltin(request.flags.query, request.flags.limit);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(toolName, request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock(toolName, request.flags, toolUseID),
  };
}

function normalizeFinderInput(input = {}) {
  const query = input.query ?? input.q ?? input.search ?? input.task ?? input.file;
  const limit = Number.parseInt(String(input.limit ?? input.count ?? 10), 10);
  return {
    ...input,
    query: query ? String(query) : '',
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 10,
  };
}

function findThreadsBuiltin(query, limit = 10) {
  const normalizedQuery = query.toLowerCase();
  const rows = listThreads()
    .filter((thread) => threadSearchText(thread).toLowerCase().includes(normalizedQuery))
    .slice(0, limit)
    .map((thread) => [
      thread.id,
      thread.archived ? 'archived' : 'active',
      thread.visibility ?? 'private',
      thread.labels?.length ? thread.labels.join(',') : '-',
      thread.title,
    ].join('\t'));
  return rows.length ? rows.join('\n') : `No threads found for ${query}`;
}

async function executePromptReadMcpResourceToolRequest(request, parsed = {}, plugins = { handlers: {} }, threadId = '') {
  if (isToolDisabled('read_mcp_resource', 'built-in', parsed)) return { output: 'Tool disabled: read_mcp_resource' };
  request = { ...request, flags: normalizeReadMcpResourceInput(request.flags) };
  if (!request.flags.server) return { output: 'read_mcp_resource requires --server' };
  if (!request.flags.uri) return { output: 'read_mcp_resource requires --uri' };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent('read_mcp_resource', request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision('read_mcp_resource', request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun('read_mcp_resource', request.flags, toolUseID, callResult);
  request = { ...callResult.request, flags: normalizeReadMcpResourceInput(callResult.request.flags) };
  const decision = resolvePermissionDecision('read_mcp_resource', request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput('read_mcp_resource', decision),
      permissionDenials: [{ tool: 'read_mcp_resource', action: decision.action, reason: 'permission' }],
    };
  }
  const server = listActiveMcpServerEntries(parsed, '')
    .find((entry) => entry.name === request.flags.server);
  if (!server) return { output: `Unknown MCP server: ${request.flags.server}` };
  const output = await readMcpResource(server.config, request.flags.uri, server.name);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent('read_mcp_resource', request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock('read_mcp_resource', request.flags, toolUseID),
  };
}

function normalizeReadMcpResourceInput(input = {}) {
  const server = input.server ?? input.name ?? input.mcp_server;
  const uri = input.uri ?? input.url ?? input.resource;
  return {
    ...input,
    server: server ? String(server) : '',
    uri: uri ? String(uri) : '',
  };
}

function pluginResultOutput(resultDecision, output) {
  return String(pluginToolResultDecisionOutput(resultDecision, output) ?? '').trimEnd();
}

function pluginTextToolRunResult(resultDecision, output, fallbackExitCode = 0) {
  return {
    output: pluginResultOutput(resultDecision, output),
    exitCode: pluginToolResultDecisionExitCode(resultDecision, fallbackExitCode),
  };
}

async function executePromptMcpToolRequest(request, parsed = {}, threadId = '', plugins = { handlers: {} }) {
  const parsedName = parseMcpToolName(request.toolName);
  if (!parsedName) return { output: `Unknown tool: ${request.toolName}` };
  if (isToolDisabled(request.toolName, 'local-mcp', parsed)) return { output: `Tool disabled: ${request.toolName}` };
  const toolUseID = createToolUseID();
  const callDecision = await runPluginEventHandlers(
    plugins.handlers['tool.call'],
    pluginToolCallEvent(request.toolName, request.flags, threadId, toolUseID),
    validateToolCallDecision,
  );
  const callResult = applyToolCallDecision(request.toolName, request, callDecision);
  if (callResult.output) return toolCallDecisionToolRun(request.toolName, request.flags, toolUseID, callResult);
  request = callResult.request;
  const decision = resolvePermissionDecision(request.toolName, request.flags, parsed, { threadId });
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: permissionDeniedOutput(request.toolName, decision),
      permissionDenials: [{ tool: request.toolName, action: decision.action, reason: 'permission' }],
    };
  }
  const server = listConfiguredMcpServers(parsed)
    .find((entry) => entry.name === parsedName.serverName && entry.status === 'approved');
  if (!server) return { output: `Unknown MCP server: ${parsedName.serverName}` };
  if (!isMcpToolIncluded(server.config, parsedName.toolName)) return { output: `Tool not available: ${request.toolName}` };
  const output = await callMcpTool(server.config, parsedName.toolName, request.flags, server.name);
  const resultDecision = await runPluginEventHandlers(
    plugins.handlers['tool.result'],
    pluginToolResultEvent(request.toolName, request.flags, 'done', output, threadId, toolUseID),
  );
  return {
    ...pluginTextToolRunResult(resultDecision, output),
    toolUse: pluginToolUseBlock(request.toolName, request.flags, toolUseID),
  };
}

function permissionDeniedOutput(toolName, decision) {
  return decision.message ? `Permission denied for ${toolName}: ${decision.message}` : `Permission denied for ${toolName}`;
}

export { UsageError };
