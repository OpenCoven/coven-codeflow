import { existsSync } from 'node:fs';

export function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function displayCwd(cwd = process.cwd()) {
  return String(cwd).replace(/^\/private\/var\//, '/var/');
}

export function addIfExists(files, filePath) {
  if (existsSync(filePath)) files.push(filePath);
}
