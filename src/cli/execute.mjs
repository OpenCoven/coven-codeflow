import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_TOOLS } from '../constants.mjs';
import { estimateUsage, localAgentResponse } from '../agent/local.mjs';
import {
  listActiveMcpServerEntries,
  listConfiguredMcpServers,
} from '../mcp/discover.mjs';
import { callLocalMcpTool, discoverMcpToolRows, parseMcpToolName } from '../mcp/probe.mjs';
import {
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
import { evaluatePermission } from '../commands/permissions.mjs';
import { persistThreadTurn, threadContinuationPrompt } from '../threads/store.mjs';
import { expandFileReferences, expandThreadReferences, imageMentionBlock } from './refs.mjs';
import { UsageError } from './parse.mjs';
import { processShellMode, splitShellWords } from '../util/shell.mjs';
import { globToRegex } from '../util/glob.mjs';
import { displayCwd, emitJson } from '../util/fs.mjs';

export async function runExecute(parsed, stdin, options = {}) {
  const started = Date.now();
  const prompt = combinePrompt(parsed.prompt, stdin, parsed.streamJsonInput);
  const sessionId = options.thread?.id ?? `T-${randomUUID()}`;
  const plugins = await loadPlugins(process.cwd());
  await runPluginEventHandlers(plugins.handlers['agent.start'], {
    message: prompt,
    thread: { id: sessionId },
  });
  const expandedPrompt = expandFileReferences(prompt);
  const guidancePrompt = expandAgentGuidanceReferences(expandedPrompt);
  const turnPrompt = guidancePrompt ? `${guidancePrompt}\n${expandedPrompt}` : expandedPrompt;
  const modelPrompt = options.thread
    ? threadContinuationPrompt(options.thread, turnPrompt)
    : expandThreadReferences(turnPrompt);
  const toolRun = await executePromptToolRequest(prompt, stdin, sessionId, parsed);
  const result = toolRun?.output ?? localAgentResponse(modelPrompt, stdin);
  await runPluginEventHandlers(plugins.handlers['agent.end'], {
    message: prompt,
    result,
    thread: { id: sessionId },
  });

  if (parsed.streamJson) {
    const activeMcpServers = listActiveMcpServerEntries(parsed, prompt);
    const pluginTools = await listPluginTools(process.cwd());
    const tools = [
      ...BUILTIN_TOOLS.map(([name]) => name),
      ...listToolboxTools().map((tool) => tool.name),
      ...pluginTools.map((tool) => tool.name),
      ...discoverMcpToolRows(activeMcpServers).map(([name]) => name),
    ].filter((name) => !isToolDisabled(name, toolKindForName(name), parsed));
    emitJson({
      type: 'system',
      subtype: 'init',
      cwd: displayCwd(),
      session_id: sessionId,
      tools,
      mcp_servers: activeMcpServers.map(({ name, source }) => ({ name, status: 'connected', source })),
      agent_mode: parsed.mode,
      reasoning_effort: parsed.mode === 'rush' ? 'minimal' : 'high',
    });
    emitJson({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
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
          usage: estimateUsage(prompt, JSON.stringify(toolRun.toolUse.input)),
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      });
      emitJson({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolRun.toolUse.id,
            content: toolRun.output,
            is_error: toolRun.exitCode !== 0,
          }],
        },
        parent_tool_use_id: toolRun.toolUse.id,
        session_id: sessionId,
      });
    }
    emitJson({
      type: 'assistant',
      message: {
        type: 'message',
        role: 'assistant',
        content: parsed.streamJsonThinking
          ? [{ type: 'thinking', thinking: 'Using the local deterministic recreation.' }, { type: 'text', text: result }]
          : [{ type: 'text', text: result }],
        stop_reason: 'end_turn',
        usage: estimateUsage(prompt, result),
      },
      parent_tool_use_id: toolRun?.toolUse?.id ?? null,
      session_id: sessionId,
    });
    emitJson({
      type: 'result',
      subtype: 'success',
      duration_ms: Date.now() - started,
      is_error: false,
      num_turns: 1,
      result,
      session_id: sessionId,
      usage: estimateUsage(prompt, result),
      permission_denials: toolRun?.permissionDenials ?? [],
    });
    return persistThreadTurn(sessionId, prompt, result, parsed.mode, options.thread);
  }

  process.stdout.write(result.endsWith('\n') ? result : `${result}\n`);
  return persistThreadTurn(sessionId, prompt, result, parsed.mode, options.thread);
}

function expandAgentGuidanceReferences(expandedPrompt) {
  const readFiles = filesInPrompt(expandedPrompt);
  const agentFiles = [
    ...discoverAgentFiles(process.cwd()),
    ...discoverSubtreeAgentFiles(readFiles),
  ];
  const blocks = [...new Set(agentFiles)]
    .map((filePath) => guidanceBlock(filePath, readFiles))
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

function guidanceBlock(filePath, readFiles) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const expandable = stripFencedCodeBlocks(content);
    const expanded = expandFileReferences(expandable, {
      baseDir: path.dirname(filePath),
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
    return stdin
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .flatMap((message) => message.message?.content ?? [])
      .map(streamJsonContentBlockText)
      .filter(Boolean)
      .join('\n');
  }

  const processedStdin = processShellMode(stdin);
  if (prompt && processedStdin.trim()) return `${prompt}\n\n${processedStdin.trimEnd()}`;
  if (prompt) return prompt;
  return processedStdin.trimEnd();
}

function streamJsonContentBlockText(block) {
  if (block.type === 'text') return block.text;
  if (block.type !== 'image') return undefined;
  if (block.source_path) {
    const filePath = block.source_path.startsWith('file://')
      ? fileURLToPath(block.source_path)
      : block.source_path;
    return imageMentionBlock(filePath);
  }
  if (block.source?.type === 'base64' && block.source.media_type && block.source.data) {
    const bytes = Buffer.from(block.source.data, 'base64').byteLength;
    return `[image:inline]\nmedia_type: ${block.source.media_type}\nbytes: ${bytes}\n[/image]`;
  }
  return undefined;
}

async function executePromptToolRequest(prompt, stdin, threadId, parsed = {}) {
  const request = parsePromptToolRequest(prompt);
  if (!request) return undefined;
  if (request.toolName.startsWith('mcp__')) return executePromptMcpToolRequest(request, parsed);
  const plugins = await loadPlugins(process.cwd());
  const pluginTool = plugins.tools.find((entry) => entry.name === request.toolName);
  if (pluginTool) return executePromptPluginToolRequest(pluginTool, request, parsed, plugins);
  const toolboxName = normalizeToolName(request.toolName);
  const tool = listToolboxTools().find((entry) => entry.name === toolboxName);
  if (!tool) return request.toolName.startsWith('tb__') ? { output: `Unknown tool: ${request.toolName}` } : undefined;
  if (isToolDisabled(tool.name, 'toolbox', parsed)) return { output: `Tool disabled: ${tool.name}` };
  const decision = evaluatePermission(tool.name, request.flags, parsed);
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: `Permission denied for ${tool.name}`,
      permissionDenials: [{ tool: tool.name, action: decision.action, reason: 'permission' }],
    };
  }
  const result = executeToolboxTool(tool, request.flags, stdin, threadId);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 0;
  return {
    output: result.stdout.trimEnd(),
    exitCode: result.status ?? 0,
    toolUse: {
      type: 'tool_use',
      id: `toolu_${randomUUID()}`,
      name: tool.name,
      input: request.flags,
    },
  };
}

function parsePromptToolRequest(prompt) {
  const match = prompt.match(/\b(?:use|run|call)\s+([A-Za-z0-9_-]+(?:__[A-Za-z0-9_-]+)?)([^\r\n]*)/i);
  if (!match) return undefined;
  const useArgs = parseToolUseArgs([match[1], ...splitShellWords(match[2] ?? '')]);
  return { toolName: useArgs.toolName, flags: useArgs.flags };
}

async function executePromptPluginToolRequest(tool, request, parsed = {}, plugins = { handlers: {} }) {
  if (isToolDisabled(tool.name, 'plugin', parsed)) return { output: `Tool disabled: ${tool.name}` };
  const callDecision = await runPluginEventHandlers(plugins.handlers['tool.call'], {
    tool: tool.name,
    input: request.flags,
  });
  if (callDecision.action === 'reject-and-continue') {
    return {
      output: callDecision.message ?? `Plugin rejected ${tool.name}`,
      exitCode: 0,
    };
  }
  if (callDecision.action === 'synthesize') {
    return {
      output: String(callDecision.output ?? callDecision.message ?? '').trimEnd(),
      exitCode: 0,
    };
  }
  if (callDecision.action === 'modify' && callDecision.input && typeof callDecision.input === 'object') {
    request = { ...request, flags: callDecision.input };
  }
  const decision = evaluatePermission(tool.name, request.flags, parsed);
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: `Permission denied for ${tool.name}`,
      permissionDenials: [{ tool: tool.name, action: decision.action, reason: 'permission' }],
    };
  }
  const output = typeof tool.execute === 'function' ? await tool.execute(request.flags) : '';
  const resultDecision = await runPluginEventHandlers(plugins.handlers['tool.result'], {
    tool: tool.name,
    input: request.flags,
    status: 'success',
    output: String(output ?? '').trimEnd(),
  });
  const finalOutput = resultDecision.output !== undefined
    ? String(resultDecision.output ?? '').trimEnd()
    : String(output ?? '').trimEnd();
  return {
    output: finalOutput,
    exitCode: 0,
    toolUse: {
      type: 'tool_use',
      id: `toolu_${randomUUID()}`,
      name: tool.name,
      input: request.flags,
    },
  };
}

function executePromptMcpToolRequest(request, parsed = {}) {
  const parsedName = parseMcpToolName(request.toolName);
  if (!parsedName) return { output: `Unknown tool: ${request.toolName}` };
  if (isToolDisabled(request.toolName, 'local-mcp', parsed)) return { output: `Tool disabled: ${request.toolName}` };
  const decision = evaluatePermission(request.toolName, request.flags, parsed);
  if (!parsed.dangerouslyAllowAll && decision.action !== 'allow') {
    return {
      output: `Permission denied for ${request.toolName}`,
      permissionDenials: [{ tool: request.toolName, action: decision.action, reason: 'permission' }],
    };
  }
  const server = listConfiguredMcpServers(parsed)
    .find((entry) => entry.name === parsedName.serverName && entry.status === 'approved');
  if (!server) return { output: `Unknown MCP server: ${parsedName.serverName}` };
  return {
    output: callLocalMcpTool(server.config, parsedName.toolName, request.flags),
    exitCode: 0,
    toolUse: {
      type: 'tool_use',
      id: `toolu_${randomUUID()}`,
      name: request.toolName,
      input: request.flags,
    },
  };
}

export { UsageError };
