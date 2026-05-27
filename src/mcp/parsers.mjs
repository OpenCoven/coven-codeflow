export function parseMcpCallOutput(stdout = '') {
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const message = JSON.parse(line);
      const content = message.result?.content ?? message.content;
      if (Array.isArray(content)) {
        return content.map((entry) => entry.text ?? entry.content ?? JSON.stringify(entry)).join('\n');
      }
      if (typeof content === 'string') return content;
      if (message.result !== undefined) return JSON.stringify(message.result);
    } catch {
      // Non-JSON diagnostic output from MCP server startup is ignored.
    }
  }
  return '';
}

export function parseMcpResourceOutput(stdout = '') {
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const message = JSON.parse(line);
      const contents = message.result?.contents ?? message.contents;
      if (Array.isArray(contents)) {
        return contents.map((entry) => entry.text ?? entry.content ?? entry.blob ?? JSON.stringify(entry)).join('\n');
      }
      if (typeof contents === 'string') return contents;
      if (message.result !== undefined) return JSON.stringify(message.result);
    } catch {
      // Non-JSON diagnostic output from MCP server startup is ignored.
    }
  }
  return '';
}

export function parseMcpToolsOutput(stdout = '') {
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const message = JSON.parse(line);
      if (Array.isArray(message.result?.tools)) return message.result.tools;
      if (Array.isArray(message.tools)) return message.tools;
    } catch {
      // Non-JSON diagnostic output from MCP server startup is ignored.
    }
  }
  return [];
}
