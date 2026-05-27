import { spawnSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './constants.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const covenCodeBin = path.join(repoRoot, 'bin', 'coven-code.mjs');

export async function runInstallCommand(args = []) {
  const command = args[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    return 0;
  }
  if (command !== 'install') {
    console.error(`coven-code-sdk: Unknown command: ${command}`);
    printUsage();
    return 1;
  }

  const parsed = parseInstallOptions(args.slice(1));
  if (parsed.errorMessage) {
    console.error(`coven-code-sdk: ${parsed.errorMessage}`);
    printUsage();
    return 1;
  }
  if (parsed.showHelp) {
    printUsage();
    return 0;
  }

  await installLocalCovenCode(parsed.options);
  return 0;
}

function printUsage() {
  console.log('Usage: coven-code-sdk install [--force]');
}

function parseInstallOptions(args = []) {
  const options = { forceInstall: false };
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') return { options, showHelp: true, errorMessage: null };
    if (arg === '--force') {
      options.forceInstall = true;
      continue;
    }
    return { options, showHelp: false, errorMessage: `Unknown option for install: ${arg}` };
  }
  return { options, showHelp: false, errorMessage: null };
}

async function installLocalCovenCode(options = {}) {
  if (!options.forceInstall) {
    const installedCli = findPreManagedInstalledCli();
    if (installedCli) {
      console.log(`Coven Code CLI ${installedCli.version} already satisfies minimum ${VERSION} (${installedCli.source}).`);
      return;
    }
  } else {
    console.log('Forcing SDK-managed install; skipping existing CLI detection.');
  }

  const target = sdkManagedCovenCodePath();
  if (!options.forceInstall && existsSync(target)) {
    const version = installedCovenCodeVersion(target);
    if (version) {
      console.log(`Coven Code CLI ${version} already satisfies minimum ${VERSION} (SDK_MANAGED).`);
      return;
    }
  }

  if (!options.forceInstall) {
    const installedCli = findPostManagedInstalledCli();
    if (installedCli) {
      console.log(`Coven Code CLI ${installedCli.version} already satisfies minimum ${VERSION} (${installedCli.source}).`);
      return;
    }
  }

  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, covenCodeWrapperSource(), 'utf8');
  if (process.platform !== 'win32') await chmod(target, 0o755);
  console.log(`Coven Code CLI ${VERSION} installed at ${target}.`);
}

function findPreManagedInstalledCli() {
  const cliPath = process.env.COVEN_CODE_CLI_PATH;
  const envVersion = cliPath && existsSync(cliPath) ? installedCovenCodeVersion(cliPath) : undefined;
  if (envVersion) return { source: 'COVEN_CODE_CLI_PATH', version: envVersion };

  const localPackage = findLocalCovenCodePackage();
  if (localPackage) return localPackage;

  return undefined;
}

function findPostManagedInstalledCli() {
  const covenCodeHomePath = path.join(resolveCovenCodeHome(), 'bin', process.platform === 'win32' ? 'coven-code.cmd' : 'coven-code');
  const covenCodeHomeVersion = existsSync(covenCodeHomePath) ? installedCovenCodeVersion(covenCodeHomePath) : undefined;
  if (covenCodeHomeVersion) return { source: process.env.COVEN_CODE_HOME ? 'COVEN_CODE_HOME' : 'COVEN_CODE_HOME', version: covenCodeHomeVersion };

  const pathCli = findCovenCodeOnPath();
  if (pathCli) return pathCli;

  return undefined;
}

function findLocalCovenCodePackage() {
  for (const packageName of ['@opencoven/coven-code']) {
    const packageJsonPath = findNodeModulePackageJson(packageName);
    if (!packageJsonPath) continue;
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      const bin = typeof packageJson.bin?.['coven-code'] === 'string' ? packageJson.bin['coven-code'] : undefined;
      if (!bin) continue;
      const cliPath = path.resolve(path.dirname(packageJsonPath), bin);
      const version = existsSync(cliPath) ? installedCovenCodeVersion(cliPath) : undefined;
      if (version) return { source: 'LOCAL_NPM', version };
    } catch {
      // Try the next package candidate.
    }
  }
  return undefined;
}

function findNodeModulePackageJson(packageName) {
  let current = process.cwd();
  while (true) {
    const candidate = path.join(current, 'node_modules', ...packageName.split('/'), 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function findCovenCodeOnPath() {
  for (const dir of process.env.PATH?.split(path.delimiter) ?? []) {
    if (!dir) continue;
    for (const name of covenCodeCommandNames()) {
      const candidate = path.join(dir, name);
      const version = existsSync(candidate) ? installedCovenCodeVersion(candidate) : undefined;
      if (version) return { source: 'PATH', version };
    }
  }
  return undefined;
}

function covenCodeCommandNames() {
  return process.platform === 'win32' ? ['coven-code.exe', 'coven-code.cmd', 'coven-code'] : ['coven-code'];
}

function sdkManagedCovenCodePath() {
  return path.join(resolveCovenCodeHome(), 'sdk', 'bin', process.platform === 'win32' ? 'coven-code.cmd' : 'coven-code');
}

function resolveCovenCodeHome() {
  return process.env.COVEN_CODE_HOME || path.join(os.homedir(), '.coven-code');
}

function covenCodeWrapperSource() {
  if (process.platform === 'win32') {
    return `@echo off\r\n"${process.execPath}" "${covenCodeBin}" %*\r\n`;
  }
  return `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const result = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(covenCodeBin)}, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
if (result.error) {
  console.error(result.error.stack || String(result.error));
  process.exit(1);
}
process.exit(result.status ?? 0);
`;
}

function installedCovenCodeVersion(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}
