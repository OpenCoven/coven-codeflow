import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { settingsFile, workspaceSettingsFile } from '../settings/paths.mjs';
import { readSettingsFile, writeSettingsFile } from '../settings/load.mjs';
import { formatMcpServerCommand, listConfiguredMcpServers } from '../mcp/discover.mjs';
import { readWorkspaceMcpApprovals, writeWorkspaceMcpApprovals } from '../mcp/permissions.mjs';
import { UsageError } from '../cli/parse.mjs';
import { printRows } from '../util/table.mjs';

export async function runMcp(args, parsed = {}) {
  const subcommand = args[0] ?? 'list';

  if (subcommand === 'oauth') {
    await runMcpOauth(args.slice(1));
    return;
  }

  if (subcommand === 'add') {
    const workspace = args.includes('--workspace');
    const tokens = args.slice(1).filter((arg) => arg !== '--workspace');
    const separator = tokens.indexOf('--');
    const name = tokens[0];
    if (!name) throw new UsageError('mcp add requires a server name');
    const specArgs = separator === -1 ? tokens.slice(1) : tokens.slice(separator + 1);
    const settingsPath = workspace ? workspaceSettingsFile(process.cwd()) : settingsFile(parsed);
    const settings = readSettingsFile(settingsPath);
    settings['amp.mcpServers'] = {
      ...(settings['amp.mcpServers'] ?? {}),
      [name]: parseMcpServerSpec(specArgs),
    };
    await writeSettingsFile(settingsPath, settings);
    console.log(`Added MCP server ${name} to ${workspace ? 'workspace' : 'user'} settings.`);
    return;
  }

  if (subcommand === 'list' || subcommand === 'doctor') {
    const rows = listConfiguredMcpServers(parsed).map((server) => [
      server.name,
      server.source,
      server.status,
      formatMcpServerCommand(server.config),
    ]);
    printRows(rows.length ? rows : [['(none)', '-', '-', '-']]);
    return;
  }

  if (subcommand === 'approve') {
    const name = args[1];
    if (!name) throw new UsageError('mcp approve requires a server name');
    const approvals = readWorkspaceMcpApprovals(process.cwd());
    approvals[name] = true;
    await writeWorkspaceMcpApprovals(process.cwd(), approvals);
    console.log(`Approved workspace MCP server ${name}.`);
    return;
  }

  throw new UsageError(`Unknown mcp command: ${subcommand}`);
}

async function runMcpOauth(args) {
  const subcommand = args[0] ?? '';
  if (subcommand === 'login') {
    const parsed = parseMcpOauthLoginArgs(args.slice(1));
    await writeSettingsFile(mcpOauthCredentialFile(parsed.name), {
      serverUrl: parsed.serverUrl,
      clientId: parsed.clientId,
      clientSecret: parsed.clientSecret,
      scopes: parsed.scopes,
    });
    console.log(`Stored OAuth credentials for ${parsed.name}.`);
    return;
  }

  if (subcommand === 'logout') {
    const name = args[1];
    if (!name) throw new UsageError('mcp oauth logout requires a server name');
    await rm(mcpOauthCredentialFile(name), { force: true });
    console.log(`Removed OAuth credentials for ${name}.`);
    return;
  }

  throw new UsageError(`Unknown mcp oauth command: ${subcommand}`);
}

function parseMcpOauthLoginArgs(args) {
  const name = args[0];
  if (!name || name.startsWith('-')) throw new UsageError('mcp oauth login requires a server name');
  const flags = parseFlagPairs(args.slice(1));
  const serverUrl = flags.get('server-url') ?? flags.get('serverUrl');
  const clientId = flags.get('client-id') ?? flags.get('clientId');
  const clientSecret = flags.get('client-secret') ?? flags.get('clientSecret');
  if (!serverUrl) throw new UsageError('mcp oauth login requires --server-url');
  if (!clientId) throw new UsageError('mcp oauth login requires --client-id');
  if (!clientSecret) throw new UsageError('mcp oauth login requires --client-secret');
  return {
    name,
    serverUrl,
    clientId,
    clientSecret,
    scopes: splitScopes(flags.get('scopes') ?? ''),
  };
}

function parseFlagPairs(args) {
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith('--')) continue;
    flags.set(key.slice(2), args[index + 1] ?? '');
    index += 1;
  }
  return flags;
}

function splitScopes(value) {
  return String(value).split(/[,\s]+/).map((scope) => scope.trim()).filter(Boolean);
}

function mcpOauthCredentialFile(name) {
  return path.join(os.homedir(), '.amp', 'oauth', `${name}.json`);
}

function parseMcpServerSpec(args) {
  if (args.length === 1 && /^https?:\/\//.test(args[0])) return { url: args[0] };
  const [command, ...commandArgs] = args;
  if (!command) throw new UsageError('mcp add requires a command or URL after --');
  return { command, args: commandArgs };
}
