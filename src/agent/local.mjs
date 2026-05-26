import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function localAgentResponse(prompt, stdin) {
  const text = prompt.trim();
  const lower = text.toLowerCase();

  if (lower.includes('now add') && lower.includes('to that')) {
    const addend = Number([...lower.matchAll(/now add\s+(\d+)\s+to that/g)].at(-1)?.[1] ?? 0);
    const prior = Number([...text.matchAll(/^assistant:\s*(\d+)\s*$/gim)].at(-1)?.[1] ?? 0);
    if (addend && prior) return String(prior + addend);
  }
  if (/\b2\s*\+\s*2\b/.test(lower)) return '4';
  if (lower.includes('markdown') && lower.includes('filename')) {
    return readdirSync(process.cwd())
      .filter((entry) => entry.toLowerCase().endsWith('.md'))
      .sort((a, b) => a.localeCompare(b))
      .join('\n');
  }
  if (lower.includes('colorscheme')) {
    const match = text.match(/^\s*colorscheme\s+([^\s#]+)/mi);
    return match ? `The colorscheme used is ${match[1]}.` : 'No colorscheme declaration found.';
  }
  if (lower.includes('package manager')) {
    return detectPackageManager();
  }
  if (lower.includes('what did the shell command output')) {
    return extractShellOutput(text) || 'No shell output is available from the captured context.';
  }
  if (lower.includes('image') && lower.includes('[image:')) {
    const match = text.match(/\[image:([^\]\r\n]+)\]\nmedia_type:\s*([^\r\n]+)\nbytes:\s*(\d+)/);
    if (match) return `${path.basename(match[1])} ${match[2]} ${match[3]} bytes`;
    return 'No image was found.';
  }
  if (lower.includes('codename') && lower.includes('[thread:')) {
    const match = text.match(/codename is ([a-z0-9_-]+)/i);
    return match ? match[1] : 'No codename was found in the referenced thread.';
  }
  if (lower.includes('codename') && lower.includes('[file:')) {
    const matches = [...text.matchAll(/codename:\s*([a-z0-9_-]+)/gi)].map((m) => m[1]);
    if (lower.includes('codenames') && matches.length > 0) return matches.join('\n');
    return matches[0] || 'No codename was found in the referenced file.';
  }
  if (lower.includes('codename')) {
    const match = text.match(/codename:\s*([a-z0-9_-]+)/i);
    if (match) return match[1];
  }
  if (lower.includes('codename')) {
    return 'No codename was found.';
  }
  if (lower.includes('review')) {
    return 'No automated review findings in the local deterministic recreation.';
  }
  if (stdin.trim()) {
    return `Received ${stdin.trim().split(/\s+/).length} input words and prompt: ${parsedSummary(text)}`;
  }
  return `Coven Code local runtime received: ${parsedSummary(text)}`;
}

export function detectPackageManager() {
  const checks = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
    ['Cargo.lock', 'cargo'],
  ];
  for (const [file, manager] of checks) {
    if (existsSync(path.join(process.cwd(), file))) return manager;
  }
  return 'unknown';
}

export function extractShellOutput(text) {
  const match = text.match(/\[shell\]\n\$ .+\n([\s\S]*?)(?:\n[^\n]*\?|$)/);
  return match?.[1]?.trim() ?? '';
}

export function parsedSummary(text) {
  return text.length > 160 ? `${text.slice(0, 157)}...` : text || '(empty message)';
}

export function estimateUsage(input, output) {
  return {
    input_tokens: estimateTokenCount(input),
    output_tokens: estimateTokenCount(output),
    max_tokens: 968000,
    service_tier: 'local-recreation',
  };
}

export function estimateTokenCount(text) {
  return Math.max(1, Math.ceil(String(text).length / 4));
}
