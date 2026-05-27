import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  repoRoot,
  covenCodeBin,
  covenCodeSdkBin,
  makeWorkspace,
  runCovenCode,
  runCovenCodeSdk,
  runGit,
  escapeRegExp,
  expectAvailable,
} from './_helpers.mjs';

test('mcp add stores user servers and mcp list reports them', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const addResult = runCovenCode(['mcp', 'add', 'context7', '--', 'npx', '-y', '@upstash/context7-mcp'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(addResult.status, 0, addResult.stderr);
  assert.match(addResult.stdout, /Added MCP server context7/);

  const settings = JSON.parse(await readFile(path.join(xdg, 'coven-code', 'settings.json'), 'utf8'));
  assert.deepEqual(settings['covenCode.mcpServers'].context7, {
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
  });

  const listResult = runCovenCode(['mcp', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /context7\s+user\s+approved\s+npx -y @upstash\/context7-mcp/);
});

test('mcp add stores remote server headers from CLI flags', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const addResult = runCovenCode([
    'mcp',
    'add',
    'linear',
    '--header',
    'Authorization=Bearer test-token',
    '--header',
    'X-Trace-Id=trace-123',
    'https://mcp.linear.app/sse',
  ], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(addResult.status, 0, addResult.stderr);
  assert.match(addResult.stdout, /Added MCP server linear/);

  const settings = JSON.parse(await readFile(path.join(xdg, 'coven-code', 'settings.json'), 'utf8'));
  assert.deepEqual(settings['covenCode.mcpServers'].linear, {
    url: 'https://mcp.linear.app/sse',
    headers: {
      Authorization: 'Bearer test-token',
      'X-Trace-Id': 'trace-123',
    },
  });
});

test('mcp oauth login stores credentials and logout removes them', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));

  const login = runCovenCode([
    'mcp',
    'oauth',
    'login',
    'linear',
    '--server-url',
    'https://mcp.linear.app/sse',
    '--client-id',
    'client-id-123',
    '--client-secret',
    'secret-456',
    '--scopes',
    'read,write',
  ], {
    env: { HOME: home },
  });
  assert.equal(login.status, 0, login.stderr);
  assert.match(login.stdout, /Stored OAuth credentials for linear/);
  assert.doesNotMatch(login.stdout, /secret-456/);

  const credentialPath = path.join(home, '.coven-code', 'oauth', 'linear.json');
  assert.deepEqual(JSON.parse(await readFile(credentialPath, 'utf8')), {
    serverUrl: 'https://mcp.linear.app/sse',
    clientId: 'client-id-123',
    clientSecret: 'secret-456',
    scopes: ['read', 'write'],
  });

  const logout = runCovenCode(['mcp', 'oauth', 'logout', 'linear'], {
    env: { HOME: home },
  });
  assert.equal(logout.status, 0, logout.stderr);
  assert.match(logout.stdout, /Removed OAuth credentials for linear/);
  await assert.rejects(readFile(credentialPath, 'utf8'), /ENOENT/);
});

test('mcp doctor probes approved local servers for health', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const healthyServer = path.join(home, 'healthy-mcp.mjs');
  const missingServer = path.join(home, 'missing-mcp');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(healthyServer, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (!chunk.includes('tools/list')) return;
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: {
      tools: [
        { name: 'lookup-docs', description: 'Lookup docs' },
        { name: 'search-docs', description: 'Search docs' }
      ]
    }
  }) + '\\n');
});
`);
  await chmod(healthyServer, 0o755);
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      healthy: { command: process.execPath, args: [healthyServer] },
      missing: { command: missingServer },
    },
  }));

  const doctor = runCovenCode(['mcp', 'doctor'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /healthy\s+user\s+approved\s+ok 2 tools\s+/);
  assert.match(doctor.stdout, /missing\s+user\s+approved\s+error ENOENT\s+/);
});

test('managed mcp settings override user and workspace settings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const workspace = await makeWorkspace();
  const managedSettings = path.join(home, 'managed-settings.json');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(workspace, '.coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      shared: { command: 'node', args: ['user-server.js'] },
    },
  }));
  await writeFile(path.join(workspace, '.coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      shared: { command: 'node', args: ['workspace-server.js'] },
    },
    'covenCode.mcpPermissions': [
      { matches: { command: 'node', args: 'workspace-server.js' }, action: 'allow' },
    ],
  }));
  await writeFile(managedSettings, JSON.stringify({
    'covenCode.mcpServers': {
      shared: { command: 'node', args: ['managed-server.js'] },
    },
    'covenCode.mcpPermissions': [
      { matches: { command: 'node', args: 'managed-server.js' }, action: 'reject' },
    ],
  }));

  const listResult = runCovenCode(['mcp', 'list'], {
    cwd: workspace,
    env: { XDG_CONFIG_HOME: xdg, HOME: home, COVEN_CODE_MANAGED_SETTINGS_FILE: managedSettings },
  });

  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /shared\s+managed\s+rejected\s+node managed-server\.js/);
  assert.doesNotMatch(listResult.stdout, /workspace-server/);
  assert.doesNotMatch(listResult.stdout, /user-server/);
});

test('--mcp-config overrides configured servers with the same name', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const configuredServerPath = path.join(home, 'configured-mcp-server.mjs');
  const inlineServerPath = path.join(home, 'inline-mcp-server.mjs');
  const serverSource = (toolName, description) => `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
	    if (message.method === 'tools/list') {
	      process.stdout.write(JSON.stringify({
	        jsonrpc: '2.0',
	        id: message.id,
        result: {
          tools: [{ name: '${toolName}', description: '${description}' }]
        }
      }) + '\\n');
      process.exit(0);
    }
  }
});
`;
  await writeFile(configuredServerPath, serverSource('configured-tool', 'Configured server tool'));
  await writeFile(inlineServerPath, serverSource('inline-tool', 'Inline server tool'));
  await chmod(configuredServerPath, 0o755);
  await chmod(inlineServerPath, 0o755);
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      shared: {
        command: process.execPath,
        args: [configuredServerPath],
      },
    },
  }));

  const stream = runCovenCode([
    '--mcp-config',
    JSON.stringify({
      mcpServers: {
        shared: {
          command: process.execPath,
          args: [inlineServerPath],
        },
      },
    }),
    '--execute',
    'what is 2+2?',
    '--stream-json',
  ], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(stream.status, 0, stream.stderr);
  const init = JSON.parse(stream.stdout.split('\n')[0]);
  assert.deepEqual(init.mcp_servers, [{ name: 'shared', status: 'connected' }]);
  assert.ok(init.tools.includes('mcp__shared__inline-tool'));
  assert.ok(!init.tools.includes('mcp__shared__configured-tool'));
});

test('--mcp-config accepts a bare JSON server map', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const serverPath = path.join(home, 'bare-map-mcp-server.mjs');
  await writeFile(serverPath, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: [{ name: 'lookup-docs', description: 'Lookup docs' }] },
      }) + '\\n');
      process.exit(0);
    }
  }
});
`);
  await chmod(serverPath, 0o755);

  const stream = runCovenCode([
    '--mcp-config',
    JSON.stringify({
      docs: {
        command: process.execPath,
        args: [serverPath],
      },
    }),
    '--execute',
    'what tools are available?',
    '--stream-json',
  ], {
    env: { HOME: home },
  });

  assert.equal(stream.status, 0, stream.stderr);
  const init = JSON.parse(stream.stdout.split('\n')[0]);
  assert.deepEqual(init.mcp_servers, [{ name: 'docs', status: 'connected' }]);
  assert.ok(init.tools.includes('mcp__docs__lookup-docs'));
});

test('covenCode.mcpRegistry gates configured MCP servers by registry remotes', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const allowedUrl = 'https://mcp.allowed.example/mcp';
  const blockedUrl = 'https://mcp.blocked.example/mcp';
  const registryPath = path.join(home, 'registry.json');
  await writeFile(registryPath, JSON.stringify({
    servers: [
      {
        server: {
          name: 'example/allowed',
          remotes: [{ type: 'streamable-http', url: allowedUrl }],
        },
      },
    ],
  }));
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpRegistry.url': pathToFileURL(registryPath).href,
    'covenCode.mcpServers': {
      allowed: { url: allowedUrl },
      blocked: { url: blockedUrl },
    },
  }));

  const listResult = runCovenCode(['mcp', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /allowed\s+user\s+approved\s+https:\/\/mcp\.allowed\.example\/mcp/);
  assert.match(listResult.stdout, /blocked\s+user\s+registry-blocked\s+https:\/\/mcp\.blocked\.example\/mcp/);
});

test('covenCode.mcpRegistry blocks all MCP servers when the registry is unreachable', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpRegistry.url': 'http://127.0.0.1:9/v0.1/servers',
    'covenCode.mcpServers': {
      local: { command: 'node', args: ['local-server.js'] },
      remote: { url: 'https://mcp.example.com/mcp' },
    },
  }));

  const listResult = runCovenCode(['mcp', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /local\s+user\s+registry-blocked\s+node local-server\.js/);
  assert.match(listResult.stdout, /remote\s+user\s+registry-blocked\s+https:\/\/mcp\.example\.com\/mcp/);
});

test('covenCode.mcpPermissions rejects matching servers before they become active', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      allowed: { command: 'node', args: ['allowed-server.js'] },
      blockedCommand: { command: 'node', args: ['blocked-server.js'] },
      blockedRemote: { url: 'https://mcp.bad.example/mcp' },
    },
    'covenCode.mcpPermissions': [
      { matches: { command: 'node', args: 'allowed*' }, action: 'allow' },
      { matches: { command: 'node' }, action: 'reject' },
      { matches: { url: '*bad.example*' }, action: 'reject' },
    ],
  }));

  const doctor = runCovenCode(['mcp', 'doctor'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /allowed\s+user\s+approved\s+error exit 1\s+node allowed-server\.js/);
  assert.match(doctor.stdout, /blockedCommand\s+user\s+rejected\s+not probed\s+node blocked-server\.js/);
  assert.match(doctor.stdout, /blockedRemote\s+user\s+rejected\s+not probed\s+https:\/\/mcp\.bad\.example\/mcp/);

  const stream = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(stream.status, 0, stream.stderr);
  assert.deepEqual(JSON.parse(stream.stdout.split('\n')[0]).mcp_servers, [
    { name: 'allowed', status: 'connected' },
  ]);
});

test('local MCP servers receive initialize lifecycle before tools list', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const recordPath = path.join(home, 'lifecycle-mcp-records.jsonl');
  const serverPath = path.join(home, 'lifecycle-mcp-server.mjs');
  await writeFile(serverPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let initialized = false;
let ready = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const line of chunk.split(/\\r?\\n/).filter(Boolean)) {
    const message = JSON.parse(line);
    appendFileSync(process.env.RECORD_PATH, JSON.stringify({ method: message.method }) + '\\n');
    if (message.method === 'initialize') {
      initialized = true;
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'lifecycle-fixture', version: '1.0.0' }
        }
      }) + '\\n');
      continue;
    }
    if (message.method === 'notifications/initialized') {
      if (initialized) ready = true;
      continue;
    }
    if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: ready
          ? { tools: [{ name: 'lifecycle-tool', description: 'Lifecycle-aware tool' }] }
          : { tools: [] }
      }) + '\\n');
    }
  }
});
`);
  await chmod(serverPath, 0o755);
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      lifecycle: {
        command: process.execPath,
        args: [serverPath],
        env: { RECORD_PATH: recordPath },
      },
    },
  }));

  const listResult = runCovenCode(['tools', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });

  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /mcp__lifecycle__lifecycle-tool\s+local-mcp\s+Lifecycle-aware tool/);
  const seen = (await readFile(recordPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).method);
  assert.deepEqual(seen, ['initialize', 'notifications/initialized', 'tools/list']);
});

test('remote MCP URL servers list and call tools over HTTP with headers', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const portPath = path.join(home, 'remote-mcp-port');
  const recordPath = path.join(home, 'remote-mcp-records.jsonl');
  const serverPath = path.join(home, 'remote-mcp-server.mjs');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(serverPath, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const server = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const message = JSON.parse(body);
    appendFileSync(process.env.RECORD_PATH, JSON.stringify({
      method: message.method,
      auth: request.headers.authorization,
      body: message
    }) + '\\n');
    response.setHeader('content-type', 'application/json');
    if (message.method === 'tools/list') {
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'lookup-docs', description: 'Lookup remote docs' }
          ]
        }
      }));
      return;
    }
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [
          { type: 'text', text: 'remote:' + message.params.arguments.query }
        ]
      }
    }));
  });
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.env.PORT_PATH, String(server.address().port));
});
`);
  await chmod(serverPath, 0o755);
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT_PATH: portPath, RECORD_PATH: recordPath },
    stdio: 'ignore',
  });
  try {
    let port = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        port = (await readFile(portPath, 'utf8')).trim();
        if (port) break;
      } catch {
        await delay(20);
      }
    }
    assert.match(port, /^\d+$/);
    await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
      'covenCode.mcpServers': {
        docs: {
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: 'Bearer test-token' },
        },
      },
      'covenCode.permissions': [
        { action: 'allow', tool: 'mcp__docs__lookup-docs' },
      ],
    }));

    const list = runCovenCode(['tools', 'list'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /mcp__docs__lookup-docs\s+local-mcp\s+Lookup remote docs/);

    const call = runCovenCode(['--execute', 'use mcp__docs__lookup-docs --query react'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });
    assert.equal(call.status, 0, call.stderr);
    assert.equal(call.stdout.trim(), 'remote:react');
    const seen = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(seen.map((entry) => [entry.method, entry.auth]), [
      ['tools/list', 'Bearer test-token'],
      ['tools/call', 'Bearer test-token'],
    ]);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
});

test('remote MCP URL servers initialize and reuse streamable HTTP session ids', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const portPath = path.join(home, 'session-mcp-port');
  const recordPath = path.join(home, 'session-mcp-records.jsonl');
  const serverPath = path.join(home, 'session-mcp-server.mjs');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(serverPath, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const sessionId = 'session-abc-123';
const server = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const message = JSON.parse(body);
    appendFileSync(process.env.RECORD_PATH, JSON.stringify({
      method: message.method,
      session: request.headers['mcp-session-id']
    }) + '\\n');
    if (message.method === 'initialize') {
      response.setHeader('mcp-session-id', sessionId);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'session-fixture', version: '1.0.0' }
        }
      }));
      return;
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202);
      response.end();
      return;
    }
    if (request.headers['mcp-session-id'] !== sessionId) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'missing session' } }));
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (message.method === 'tools/list') {
      response.setHeader('mcp-session-id', sessionId);
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: [{ name: 'session-docs', description: 'Session docs' }] }
      }));
      return;
    }
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'session:' + message.params.arguments.query }] }
    }));
  });
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.env.PORT_PATH, String(server.address().port));
});
`);
  await chmod(serverPath, 0o755);
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT_PATH: portPath, RECORD_PATH: recordPath },
    stdio: 'ignore',
  });
  try {
    let port = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        port = (await readFile(portPath, 'utf8')).trim();
        if (port) break;
      } catch {
        await delay(20);
      }
    }
    assert.match(port, /^\d+$/);
    await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
      'covenCode.mcpServers': {
        docs: { url: `http://127.0.0.1:${port}/mcp` },
      },
      'covenCode.permissions': [
        { action: 'allow', tool: 'mcp__docs__session-docs' },
      ],
    }));

    const call = runCovenCode(['--execute', 'use mcp__docs__session-docs --query react'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });

    assert.equal(call.status, 0, call.stderr);
    assert.equal(call.stdout.trim(), 'session:react');
    const seen = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(seen.map((entry) => [entry.method, entry.session]), [
      ['tools/call', undefined],
      ['initialize', undefined],
      ['notifications/initialized', 'session-abc-123'],
      ['tools/call', 'session-abc-123'],
    ]);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
});

test('remote MCP URL servers use stored OAuth access tokens', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const portPath = path.join(home, 'oauth-mcp-port');
  const recordPath = path.join(home, 'oauth-mcp-records.jsonl');
  const serverPath = path.join(home, 'oauth-mcp-server.mjs');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(home, '.coven-code', 'oauth'), { recursive: true });
  await writeFile(serverPath, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const server = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const message = JSON.parse(body);
    appendFileSync(process.env.RECORD_PATH, JSON.stringify({
      method: message.method,
      auth: request.headers.authorization
    }) + '\\n');
    if (request.headers.authorization !== 'Bearer oauth-token-123') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'unauthorized' } }));
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (message.method === 'tools/list') {
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: [{ name: 'oauth-docs', description: 'OAuth docs' }] }
      }));
      return;
    }
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'oauth:' + message.params.arguments.query }] }
    }));
  });
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.env.PORT_PATH, String(server.address().port));
});
`);
  await chmod(serverPath, 0o755);
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT_PATH: portPath, RECORD_PATH: recordPath },
    stdio: 'ignore',
  });
  try {
    let port = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        port = (await readFile(portPath, 'utf8')).trim();
        if (port) break;
      } catch {
        await delay(20);
      }
    }
    assert.match(port, /^\d+$/);
    await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
      'covenCode.mcpServers': {
        docs: { url: `http://127.0.0.1:${port}/mcp` },
      },
      'covenCode.permissions': [
        { action: 'allow', tool: 'mcp__docs__oauth-docs' },
      ],
    }));
    await writeFile(path.join(home, '.coven-code', 'oauth', 'docs.json'), JSON.stringify({
      serverUrl: `http://127.0.0.1:${port}/mcp`,
      accessToken: 'oauth-token-123',
    }));

    const list = runCovenCode(['tools', 'list'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /mcp__docs__oauth-docs\s+local-mcp\s+OAuth docs/);

    const call = runCovenCode(['--execute', 'use mcp__docs__oauth-docs --query react'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });
    assert.equal(call.status, 0, call.stderr);
    assert.equal(call.stdout.trim(), 'oauth:react');
    const seen = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(seen.map((entry) => [entry.method, entry.auth]), [
      ['tools/list', 'Bearer oauth-token-123'],
      ['tools/call', 'Bearer oauth-token-123'],
    ]);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
});

test('remote MCP URL servers refresh stale OAuth access tokens', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const portPath = path.join(home, 'refresh-mcp-port');
  const recordPath = path.join(home, 'refresh-mcp-records.jsonl');
  const serverPath = path.join(home, 'refresh-mcp-server.mjs');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await mkdir(path.join(home, '.coven-code', 'oauth'), { recursive: true });
  await writeFile(serverPath, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const server = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    appendFileSync(process.env.RECORD_PATH, JSON.stringify({
      method: request.method,
      url: request.url,
      auth: request.headers.authorization,
      body
    }) + '\\n');
    if (request.method === 'POST' && request.url === '/oauth/token') {
      const params = new URLSearchParams(body);
      if (params.get('grant_type') !== 'refresh_token' || params.get('refresh_token') !== 'refresh-token-1') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        access_token: 'fresh-token-456',
        refresh_token: 'refresh-token-2',
        expires_in: 3600
      }));
      return;
    }
    const message = JSON.parse(body);
    if (request.headers.authorization !== 'Bearer fresh-token-456') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'expired' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    if (message.method === 'tools/list') {
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: [{ name: 'refresh-docs', description: 'Refresh docs' }] }
      }));
      return;
    }
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'refresh:' + message.params.arguments.query }] }
    }));
  });
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.env.PORT_PATH, String(server.address().port));
});
`);
  await chmod(serverPath, 0o755);
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT_PATH: portPath, RECORD_PATH: recordPath },
    stdio: 'ignore',
  });
  try {
    let port = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        port = (await readFile(portPath, 'utf8')).trim();
        if (port) break;
      } catch {
        await delay(20);
      }
    }
    assert.match(port, /^\d+$/);
    await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
      'covenCode.mcpServers': {
        docs: { url: `http://127.0.0.1:${port}/mcp` },
      },
      'covenCode.permissions': [
        { action: 'allow', tool: 'mcp__docs__refresh-docs' },
      ],
    }));
    const credentialPath = path.join(home, '.coven-code', 'oauth', 'docs.json');
    await writeFile(credentialPath, JSON.stringify({
      serverUrl: `http://127.0.0.1:${port}/mcp`,
      tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
      clientId: 'client-id-1',
      clientSecret: 'secret-1',
      accessToken: 'stale-token-123',
      refreshToken: 'refresh-token-1',
    }));

    const list = runCovenCode(['tools', 'list'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /mcp__docs__refresh-docs\s+local-mcp\s+Refresh docs/);
    const updatedCredential = JSON.parse(await readFile(credentialPath, 'utf8'));
    assert.match(String(updatedCredential.expiresAt), /^\d+$/);
    delete updatedCredential.expiresAt;
    assert.deepEqual(updatedCredential, {
      serverUrl: `http://127.0.0.1:${port}/mcp`,
      tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
      clientId: 'client-id-1',
      clientSecret: 'secret-1',
      accessToken: 'fresh-token-456',
      refreshToken: 'refresh-token-2',
    });

    const call = runCovenCode(['--execute', 'use mcp__docs__refresh-docs --query react'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });
    assert.equal(call.status, 0, call.stderr);
    assert.equal(call.stdout.trim(), 'refresh:react');
    const seen = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(seen.map((entry) => [entry.url, entry.auth]), [
      ['/mcp', 'Bearer stale-token-123'],
      ['/oauth/token', undefined],
      ['/mcp', 'Bearer fresh-token-456'],
      ['/mcp', 'Bearer fresh-token-456'],
    ]);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
});

test('remote MCP URL servers fall back to legacy SSE endpoint discovery', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const portPath = path.join(home, 'legacy-sse-mcp-port');
  const recordPath = path.join(home, 'legacy-sse-mcp-records.jsonl');
  const serverPath = path.join(home, 'legacy-sse-mcp-server.mjs');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(serverPath, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const server = createServer((request, response) => {
  appendFileSync(process.env.RECORD_PATH, JSON.stringify({
    method: request.method,
    url: request.url,
    accept: request.headers.accept,
    auth: request.headers.authorization
  }) + '\\n');
  if (request.method === 'GET' && request.url === '/sse') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('event: endpoint\\ndata: /messages\\n\\n');
    return;
  }
  if (request.method === 'POST' && request.url === '/sse') {
    response.writeHead(405);
    response.end('legacy sse only');
    return;
  }
  if (request.method === 'POST' && request.url === '/messages') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const message = JSON.parse(body);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'legacy-search', description: 'Search legacy docs' }
          ]
        }
      }));
    });
    return;
  }
  response.writeHead(404);
  response.end('not found');
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.env.PORT_PATH, String(server.address().port));
});
`);
  await chmod(serverPath, 0o755);
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT_PATH: portPath, RECORD_PATH: recordPath },
    stdio: 'ignore',
  });
  try {
    let port = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        port = (await readFile(portPath, 'utf8')).trim();
        if (port) break;
      } catch {
        await delay(20);
      }
    }
    assert.match(port, /^\d+$/);
    await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
      'covenCode.mcpServers': {
        legacy: {
          url: `http://127.0.0.1:${port}/sse`,
          headers: { Authorization: 'Bearer legacy-token' },
        },
      },
    }));

    const list = runCovenCode(['tools', 'list'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });

    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /mcp__legacy__legacy-search\s+local-mcp\s+Search legacy docs/);
    const seen = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(seen.map((entry) => [entry.method, entry.url, entry.auth]), [
      ['POST', '/sse', 'Bearer legacy-token'],
      ['GET', '/sse', 'Bearer legacy-token'],
      ['POST', '/messages', 'Bearer legacy-token'],
    ]);
    assert.match(seen[1].accept, /text\/event-stream/);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
});

test('remote MCP URL servers honor explicit SSE transport', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const portPath = path.join(home, 'explicit-sse-mcp-port');
  const recordPath = path.join(home, 'explicit-sse-mcp-records.jsonl');
  const serverPath = path.join(home, 'explicit-sse-mcp-server.mjs');
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(serverPath, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const server = createServer((request, response) => {
  appendFileSync(process.env.RECORD_PATH, JSON.stringify({
    method: request.method,
    url: request.url,
    accept: request.headers.accept
  }) + '\\n');
  if (request.method === 'GET' && request.url === '/sse') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('event: endpoint\\ndata: /messages\\n\\n');
    return;
  }
  if (request.method === 'POST' && request.url === '/sse') {
    response.writeHead(500);
    response.end('streamable endpoint should not be probed');
    return;
  }
  if (request.method === 'POST' && request.url === '/messages') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const message = JSON.parse(body);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'forced-sse', description: 'Explicit SSE transport' }
          ]
        }
      }));
    });
    return;
  }
  response.writeHead(404);
  response.end('not found');
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.env.PORT_PATH, String(server.address().port));
});
`);
  await chmod(serverPath, 0o755);
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT_PATH: portPath, RECORD_PATH: recordPath },
    stdio: 'ignore',
  });
  try {
    let port = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        port = (await readFile(portPath, 'utf8')).trim();
        if (port) break;
      } catch {
        await delay(20);
      }
    }
    assert.match(port, /^\d+$/);
    await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
      'covenCode.mcpServers': {
        docs: {
          url: `http://127.0.0.1:${port}/sse`,
          transport: 'sse',
        },
      },
    }));

    const list = runCovenCode(['tools', 'list'], {
      env: { XDG_CONFIG_HOME: xdg, HOME: home },
    });

    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /mcp__docs__forced-sse\s+local-mcp\s+Explicit SSE transport/);
    const seen = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(seen.map((entry) => [entry.method, entry.url]), [
      ['GET', '/sse'],
      ['POST', '/messages'],
    ]);
    assert.match(seen[0].accept, /text\/event-stream/);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
});

test('configured MCP includeTools filters exposed local MCP tools', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const serverPath = path.join(home, 'mcp-server.mjs');
  await writeFile(serverPath, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'resolve-library-id', description: 'Resolve a package name' },
            { name: 'get-library-docs', description: 'Fetch library documentation' },
            { name: 'dangerous-delete', description: 'Delete production data' }
          ]
        }
      }) + '\\n');
      process.exit(0);
    }
  }
});
`);
  await chmod(serverPath, 0o755);
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      context7: {
        command: process.execPath,
        args: [serverPath],
        includeTools: ['resolve-*', 'get-library-docs'],
      },
    },
  }));

  const listResult = runCovenCode(['tools', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /mcp__context7__resolve-library-id\s+local-mcp\s+Resolve a package name/);
  assert.match(listResult.stdout, /mcp__context7__get-library-docs\s+local-mcp\s+Fetch library documentation/);
  assert.doesNotMatch(listResult.stdout, /mcp__context7__dangerous-delete/);

  const stream = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(stream.status, 0, stream.stderr);
  const init = JSON.parse(stream.stdout.split('\n')[0]);
  assert.ok(init.tools.includes('mcp__context7__resolve-library-id'));
  assert.ok(init.tools.includes('mcp__context7__get-library-docs'));
  assert.ok(!init.tools.includes('mcp__context7__dangerous-delete'));

  const directCall = runCovenCode(['--dangerously-allow-all', '--execute', 'use mcp__context7__dangerous-delete'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(directCall.status, 0, directCall.stderr);
  assert.equal(directCall.stdout.trim(), 'Tool not available: mcp__context7__dangerous-delete');
});

test('disabled MCP servers stay inactive and hidden from tool discovery', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const activeServerPath = path.join(home, 'active-mcp-server.mjs');
  const disabledServerPath = path.join(home, 'disabled-mcp-server.mjs');
  const markerPath = path.join(home, 'disabled-server-ran');
  await writeFile(activeServerPath, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (!chunk.includes('tools/list')) return;
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { tools: [{ name: 'active-tool', description: 'Active MCP tool' }] }
  }) + '\\n');
});
`);
  await writeFile(disabledServerPath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.MARKER_PATH, 'spawned');
process.stdin.resume();
`);
  await chmod(activeServerPath, 0o755);
  await chmod(disabledServerPath, 0o755);
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      active: { command: process.execPath, args: [activeServerPath] },
      disabled: { command: process.execPath, args: [disabledServerPath], env: { MARKER_PATH: markerPath }, disabled: true },
    },
  }));

  const list = runCovenCode(['tools', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /mcp__active__active-tool\s+local-mcp\s+Active MCP tool/);
  assert.doesNotMatch(list.stdout, /mcp__disabled__/);

  const stream = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(stream.status, 0, stream.stderr);
  assert.deepEqual(JSON.parse(stream.stdout.split('\n')[0]).mcp_servers, [
    { name: 'active', status: 'connected' },
  ]);
  await assert.rejects(readFile(markerPath, 'utf8'), /ENOENT/);
});

test('configured MCP servers expand environment variables before spawning', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');
  const serverPath = path.join(home, 'mcp-server.mjs');
  await writeFile(serverPath, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: process.env.MCP_TOOL_NAME, description: process.argv[2] }
          ]
        }
      }) + '\\n');
      process.exit(0);
    }
  }
});
`);
  await chmod(serverPath, 0o755);
  await mkdir(path.join(xdg, 'coven-code'), { recursive: true });
  await writeFile(path.join(xdg, 'coven-code', 'settings.json'), JSON.stringify({
    'covenCode.mcpServers': {
      envdocs: {
        command: '${NODE_BIN}',
        args: [serverPath, 'Docs from ${MCP_DOC_SOURCE}'],
        env: {
          MCP_TOOL_NAME: '${MCP_TOOL_NAME}',
        },
      },
    },
  }));

  const listResult = runCovenCode(['tools', 'list'], {
    env: {
      XDG_CONFIG_HOME: xdg,
      HOME: home,
      NODE_BIN: process.execPath,
      MCP_TOOL_NAME: 'env-docs',
      MCP_DOC_SOURCE: 'config env',
    },
  });

  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /mcp__envdocs__env-docs\s+local-mcp\s+Docs from config env/);
});
