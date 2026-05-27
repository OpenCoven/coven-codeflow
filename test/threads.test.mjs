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

test('threads visibility updates persisted thread sharing level', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const run = runCovenCode(['--execute', 'draft the public release note', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const update = runCovenCode(['threads', 'visibility', threadId, 'public'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, new RegExp(`Set ${threadId} visibility to public`));

  const show = runCovenCode(['threads', 'show', threadId], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /visibility: public/);

  const workspaceShared = runCovenCode(['threads', 'visibility', threadId, 'workspace-shared'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(workspaceShared.status, 0, workspaceShared.stderr);
  assert.match(workspaceShared.stdout, new RegExp(`Set ${threadId} visibility to workspace`));

  const invalid = runCovenCode(['threads', 'visibility', threadId, 'team'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /visibility must be one of: private, public, workspace, workspace-shared, group, group-shared, unlisted/);
});

test('threads search finds matching prompts and archive hides threads from active list', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const run = runCovenCode(['--execute', 'investigate indexing logic in src/server/index.ts', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const search = runCovenCode(['threads', 'search', 'indexing'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, new RegExp(threadId));

  const archive = runCovenCode(['threads', 'archive', threadId], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(archive.status, 0, archive.stderr);
  assert.match(archive.stdout, /Archived thread/);

  const active = runCovenCode(['threads', 'list'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(active.status, 0, active.stderr);
  assert.doesNotMatch(active.stdout, new RegExp(threadId));

  const archived = runCovenCode(['threads', 'list', '--archived'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(archived.status, 0, archived.stderr);
  assert.match(archived.stdout, new RegExp(`${threadId}\\s+archived`));
});

test('threads search finds persisted threads by creation date', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const run = runCovenCode(['--execute', 'investigate rollout schedule', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;
  const thread = JSON.parse(await readFile(path.join(xdg, 'coven-code', 'threads', `${threadId}.json`), 'utf8'));
  const date = thread.createdAt.slice(0, 10);

  const search = runCovenCode(['threads', 'search', date], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, new RegExp(threadId));
});

test('thread references by @id add prior thread context to execute prompts', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const first = runCovenCode(['--execute', 'the migration codename is quartz-river', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout.trim().split('\n').at(-1)).session_id;

  const second = runCovenCode(['--execute', `what codename was mentioned in @${threadId}?`], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /quartz-river/);
});

test('thread search mentions by @@query add the newest matching prior thread context', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const unrelated = runCovenCode(['--execute', 'the migration codename is old-river', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(unrelated.status, 0, unrelated.stderr);

  const matched = runCovenCode(['--execute', 'the search-anchor codename is amber-lake', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(matched.status, 0, matched.stderr);

  const referenced = runCovenCode(['--execute', 'what codename was mentioned in @@search-anchor?'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(referenced.status, 0, referenced.stderr);
  assert.match(referenced.stdout, /amber-lake/);
  assert.doesNotMatch(referenced.stdout, /old-river/);
});

test('threads continue appends execute-mode turns to the latest active thread', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const first = runCovenCode(['--execute', 'what is 2+2?', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout.trim().split('\n').at(-1)).session_id;

  const continued = runCovenCode(['threads', 'continue', '--execute', 'now add 8 to that', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(continued.status, 0, continued.stderr);
  const messages = continued.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.type), ['system', 'user', 'assistant', 'result']);
  assert.equal(messages[0].session_id, threadId);
  assert.equal(messages[2].message.content[0].text, '12');
  assert.equal(messages[3].result, '12');
  assert.equal(messages[3].session_id, threadId);

  const show = runCovenCode(['threads', 'show', threadId], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /user: what is 2\+2\?/);
  assert.match(show.stdout, /assistant: 4/);
  assert.match(show.stdout, /user: now add 8 to that/);
  assert.match(show.stdout, /assistant: 12/);
});

test('threads handoff is removed in the rebuilt CLI', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const run = runCovenCode(['--execute', 'phase one: add parser tests before implementation', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const handoff = runCovenCode(['threads', 'handoff', threadId, '--goal', 'execute phase two'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(handoff.status, 2);
  assert.match(handoff.stderr, /Unknown threads command: handoff/);
});

test('threads map shows locally connected thread references', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const parent = runCovenCode(['--execute', 'parent thread tracks parser cleanup', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(parent.status, 0, parent.stderr);
  const parentThreadId = JSON.parse(parent.stdout.trim().split('\n').at(-1)).session_id;

  const child = runCovenCode(['--execute', `continue the parser cleanup from @${parentThreadId}`, '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(child.status, 0, child.stderr);
  const childThreadId = JSON.parse(child.stdout.trim().split('\n').at(-1)).session_id;

  const map = runCovenCode(['threads', 'map', childThreadId], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(map.status, 0, map.stderr);
  assert.match(map.stdout, new RegExp(`Thread map for ${childThreadId}`));
  assert.match(map.stdout, new RegExp(`${escapeRegExp(childThreadId)}\\s+continue the parser cleanup`));
  assert.match(map.stdout, new RegExp(`mentions -> ${escapeRegExp(parentThreadId)}\\s+parent thread tracks parser cleanup`));
});

test('threads report creates a diagnostic report id for support', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'coven-code-home-'));
  const xdg = path.join(home, '.config');

  const run = runCovenCode(['--execute', 'diagnose flaky cli startup', '--stream-json'], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  const threadId = JSON.parse(run.stdout.trim().split('\n').at(-1)).session_id;

  const report = runCovenCode(['threads', 'report', threadId], {
    env: { XDG_CONFIG_HOME: xdg, HOME: home },
  });
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /diagnostic_report_id: R-/);
  assert.match(report.stdout, new RegExp(`thread_id: ${threadId}`));
});
