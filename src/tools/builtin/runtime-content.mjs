export function isPluginContentBlock(block) {
  if (!block || typeof block !== 'object') return false;
  if (block.type === 'text') return typeof block.text === 'string';
  if (block.type === 'image') return typeof block.mimeType === 'string' && typeof block.data === 'string';
  return false;
}

export function pluginContentBlockText(block) {
  if (block.type === 'text') return block.text;
  return '';
}

export function normalizePluginToolOutput(output) {
  if (Array.isArray(output) && output.every(isPluginContentBlock)) {
    const text = output.map(pluginContentBlockText).filter(Boolean).join('\n').trimEnd();
    return { raw: output, text };
  }
  const text = String(output ?? '').trimEnd();
  return { raw: text, text };
}

export function normalizePluginToolExecuteOutput(output) {
  if (output === undefined || typeof output === 'string') return normalizePluginToolOutput(output);
  if (Array.isArray(output)) {
    if (!output.every(isPluginContentBlock)) {
      throw new Error('plugin tool result content blocks must be text or image blocks');
    }
    return normalizePluginToolOutput(output);
  }
  throw new Error('plugin tool result must be a string, content blocks, or undefined');
}
