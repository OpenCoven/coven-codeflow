import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function splitShellWords(line) {
  const tokens = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match;
  while ((match = re.exec(line))) {
    tokens.push((match[1] ?? match[2] ?? match[3]).replace(/\\(["'])/g, '$1'));
  }
  return tokens;
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function runShellCommand(command) {
  return spawnSync(command, {
    cwd: process.cwd(),
    env: process.env,
    shell: process.env.SHELL || true,
    encoding: 'utf8',
  });
}

export function processShellMode(input) {
  const lines = input.split(/\r?\n/);
  const promptLines = [];

  for (const line of lines) {
    if (line.startsWith('$$ ')) {
      runShellCommand(line.slice(3));
      continue;
    }
    if (line.startsWith('$ ')) {
      const command = line.slice(2);
      const result = runShellCommand(command);
      promptLines.push(`[shell]\n$ ${command}\n${result.stdout}${result.stderr}`.trimEnd());
      continue;
    }
    promptLines.push(line);
  }

  return promptLines.join('\n');
}

export function readStdin() {
  if (process.stdin.isTTY) return '';
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}
