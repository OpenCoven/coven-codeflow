import { fileURLToPath } from 'node:url';
import { detectImageMediaType, imageMediaTypeExtension } from '../util/media.mjs';
import { UsageError } from './parse.mjs';
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
