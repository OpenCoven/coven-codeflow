import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UsageError } from '../cli/parse.mjs';
import { configDir } from '../settings/paths.mjs';

const API_KEY_ENV = 'COVEN_CODE_API_KEY';
const CONFIG_SUBDIR = 'coven-code';

export async function runLogin(args = []) {
  const subcommand = args[0] ?? '';
  if (subcommand === 'status') {
    printLoginStatus();
    return;
  }
  if (subcommand === 'logout') {
    await rm(authFile(), { force: true });
    console.log('Logged out locally');
    return;
  }
  if (subcommand) throw new UsageError(`Unknown login command: ${subcommand}`);

  const apiKey = envApiKey();
  if (!apiKey) {
    console.log('Create or retrieve a Coven Code access token.');
    console.log(`Then run: export ${API_KEY_ENV}=<token>`);
    console.log(`Or set ${API_KEY_ENV} and run \`coven-code login\` to store it locally.`);
    return;
  }

  await writeAuth({ accessToken: apiKey.token, source: apiKey.source });
  console.log(`Logged in with ${apiKey.source} (${maskToken(apiKey.token)})`);
}

function printLoginStatus() {
  const apiKey = envApiKey();
  if (apiKey) {
    console.log('auth_status: logged_in');
    console.log(`source: ${apiKey.source}`);
    console.log(`token: ${maskToken(apiKey.token)}`);
    return;
  }
  const auth = readAuth();
  if (auth?.accessToken) {
    console.log('auth_status: logged_in');
    console.log(`source: ${auth.source ?? 'local'}`);
    console.log(`token: ${maskToken(auth.accessToken)}`);
    return;
  }
  console.log('auth_status: logged_out');
  console.log('source: none');
}

async function writeAuth(auth) {
  const filePath = authFile();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(auth, null, 2)}\n`, 'utf8');
  await chmod(filePath, 0o600);
}

function readAuth() {
  const filePath = authFile();
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function envApiKey() {
  const token = process.env[API_KEY_ENV]?.trim();
  if (token) return { token, source: API_KEY_ENV };
  return undefined;
}

function authFile(subdir = CONFIG_SUBDIR) {
  return path.join(configDir(), subdir, 'auth.json');
}

function maskToken(token = '') {
  if (token.length <= 8) return '<redacted>';
  return `${token.slice(0, 13)}…${token.slice(-4)}`;
}
