import { fileURLToPath } from 'node:url';
import { BUILTIN_TOOLS } from '../constants.mjs';
import { estimateUsage } from '../agent/fixture.mjs';
import { listActiveMcpServerEntries } from '../mcp/discover.mjs';
import { discoverMcpToolRows } from '../mcp/probe.mjs';
import { readEffectiveSettings } from '../settings/load.mjs';
import { isToolDisabled, listToolboxTools, toolKindForName } from '../tools/toolbox.mjs';
import { toolResultContent } from '../tools/builtin/runtime.mjs';
import { detectImageMediaType, imageMediaTypeExtension } from '../util/media.mjs';
import { displayCwd, emitJson } from '../util/fs.mjs';
import { UsageError } from './parse.mjs';
import { reasoningEffortForMode } from './reasoning.mjs';
import { imageMentionBlock } from './refs.mjs';

export function streamJsonInputMessages(prompt, stdin) {
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

export function streamJsonOutputUserContent(content = []) {
  const textBlocks = content.filter((block) => block.type === 'text');
  return textBlocks.length > 0 ? textBlocks : [{ type: 'text', text: '' }];
}

export function toolRunParent(toolRun, field, fallback) {
  return Object.hasOwn(toolRun, field) ? toolRun[field] : fallback;
}

export function streamJsonTurnCount(turns = []) {
  return turns.reduce((count, turn) => count + (turn.toolRun?.toolUse ? 2 : 1), 0);
}

export function streamJsonPermissionDenials(denials = []) {
  return denials.map((denial) => {
    if (typeof denial === 'string') return denial;
    const reason = denial.reason ? ` (${denial.reason})` : '';
    return `${denial.tool}: ${denial.action}${reason}`;
  });
}

export function assistantStreamContent(result, parsed = {}) {
  if (parsed.streamJsonThinking && readEffectiveSettings(parsed)['covenCode.thinking.enabled'] !== false) {
    return [{ type: 'thinking', thinking: 'Using the local deterministic recreation.' }, { type: 'text', text: result }];
  }
  return [{ type: 'text', text: result }];
}

export async function emitStreamJsonInit({ parsed, plugins, sessionId, promptForMcpDiscovery }) {
  const activeMcpServers = listActiveMcpServerEntries(parsed, promptForMcpDiscovery);
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
}

export function emitStreamJsonTurn({
  userContent,
  steer = false,
  promptText,
  toolRun,
  result,
  parsed,
  sessionId,
  assistantParentToolUseId,
}) {
  emitJson({
    type: 'user',
    ...(steer ? { steer: true } : {}),
    message: { role: 'user', content: userContent },
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
        usage: estimateUsage(promptText, JSON.stringify(toolRun.toolUse.input)),
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
          usage: estimateUsage(promptText, subagentMessage.text ?? ''),
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
  }
  emitJson({
    type: 'assistant',
    message: {
      type: 'message',
      role: 'assistant',
      content: assistantStreamContent(result, parsed),
      stop_reason: 'end_turn',
      usage: estimateUsage(promptText, result),
    },
    parent_tool_use_id: assistantParentToolUseId,
    session_id: sessionId,
  });
}

export function streamJsonResultMessage({ started, isError, errorSubtype, numTurns, result, sessionId, usage, permissionDenials }) {
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
