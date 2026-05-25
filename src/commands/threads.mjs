import { randomUUID } from 'node:crypto';
import {
  latestActiveThread,
  listThreads,
  normalizeThreadVisibility,
  requireThread,
  THREAD_VISIBILITY_INPUTS,
  threadSearchText,
  writeThread,
} from '../threads/store.mjs';
import { runExecute } from '../cli/execute.mjs';
import { THREAD_URL_BASE } from '../constants.mjs';
import { UsageError } from '../cli/parse.mjs';
import { printRows } from '../util/table.mjs';

export async function runThreads(args, parsed = {}, stdin = '') {
  const subcommand = args[0] ?? 'list';

  if (subcommand === 'continue') {
    if (!parsed.execute) throw new UsageError('threads continue requires --execute');
    const threadId = args.slice(1).find((arg) => !arg.startsWith('-'));
    const thread = threadId ? requireThread(threadId) : latestActiveThread();
    if (!thread) throw new UsageError('No active thread to continue');
    await runExecute(parsed, stdin, { thread });
    return;
  }

  if (subcommand === 'list') {
    const includeArchived = args.includes('--archived');
    const rows = listThreads()
      .filter((thread) => includeArchived || !thread.archived)
      .map((thread) => [
        thread.id,
        thread.archived ? 'archived' : 'active',
        thread.visibility ?? 'private',
        formatLabels(thread.labels),
        thread.title,
      ]);
    printRows(rows.length ? rows : [['(none)', '-', '-', '-', '-']]);
    return;
  }

  if (subcommand === 'show') {
    const thread = requireThread(args[1]);
    console.log(`thread_id: ${thread.id}`);
    console.log(`url: ${THREAD_URL_BASE}/${thread.id}`);
    console.log(`status: ${thread.archived ? 'archived' : 'active'}`);
    console.log(`visibility: ${thread.visibility ?? 'private'}`);
    console.log(`labels: ${formatLabels(thread.labels, ', ')}`);
    console.log(`cwd: ${thread.cwd}`);
    for (const message of thread.messages) {
      console.log(`${message.role}: ${message.content}`);
    }
    return;
  }

  if (subcommand === 'search') {
    const query = args.slice(1).join(' ').toLowerCase();
    const rows = listThreads()
      .filter((thread) => threadSearchText(thread).toLowerCase().includes(query))
      .map((thread) => [thread.id, thread.archived ? 'archived' : 'active', thread.visibility ?? 'private', formatLabels(thread.labels), thread.title]);
    printRows(rows.length ? rows : [['(none)', '-', '-', '-', '-']]);
    return;
  }

  if (subcommand === 'map') {
    const root = args[1] ? requireThread(args[1]) : latestActiveThread();
    if (!root) throw new UsageError('No active thread to map');
    console.log(`Thread map for ${root.id}`);
    for (const row of threadMapRows(root.id)) {
      console.log(row);
    }
    return;
  }

  if (subcommand === 'archive') {
    const thread = requireThread(args[1]);
    thread.archived = true;
    thread.updatedAt = new Date().toISOString();
    await writeThread(thread);
    console.log(`Archived thread ${thread.id}`);
    return;
  }

  if (subcommand === 'visibility' || subcommand === 'set-visibility') {
    const thread = requireThread(args[1]);
    const visibility = normalizeThreadVisibility(args[2]);
    if (!visibility) {
      throw new UsageError(`visibility must be one of: ${THREAD_VISIBILITY_INPUTS.join(', ')}`);
    }
    thread.visibility = visibility;
    thread.updatedAt = new Date().toISOString();
    await writeThread(thread);
    console.log(`Set ${thread.id} visibility to ${visibility}`);
    return;
  }

  if (subcommand === 'report') {
    const thread = requireThread(args[1]);
    const reportId = `R-${randomUUID()}`;
    console.log(`diagnostic_report_id: ${reportId}`);
    console.log(`thread_id: ${thread.id}`);
    console.log('retention: 7 days');
    return;
  }

  throw new UsageError(`Unknown threads command: ${subcommand}`);
}

function formatLabels(labels = [], separator = ',') {
  return labels.length > 0 ? labels.join(separator) : '-';
}

function threadMapRows(rootId) {
  const threads = listThreads();
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const edges = threadReferenceEdges(threads);
  const seen = new Set();
  const queue = [rootId];
  const rows = [];

  while (queue.length > 0) {
    const threadId = queue.shift();
    if (seen.has(threadId)) continue;
    seen.add(threadId);
    const thread = byId.get(threadId);
    if (!thread) continue;
    rows.push(`${thread.id} ${thread.title}`);

    for (const edge of edges.filter((entry) => entry.from === threadId || entry.to === threadId)) {
      const neighborId = edge.from === threadId ? edge.to : edge.from;
      const neighbor = byId.get(neighborId);
      if (!neighbor) continue;
      const label = edge.from === threadId ? 'mentions ->' : '<- mentioned by';
      rows.push(`  ${label} ${neighbor.id} ${neighbor.title}`);
      if (!seen.has(neighborId)) queue.push(neighborId);
    }
  }

  return rows;
}

function threadReferenceEdges(threads) {
  const knownIds = new Set(threads.map((thread) => thread.id));
  const edges = [];
  const seen = new Set();
  for (const thread of threads) {
    for (const message of thread.messages ?? []) {
      for (const ref of threadReferences(message.content)) {
        if (ref === thread.id || !knownIds.has(ref)) continue;
        const key = `${thread.id}->${ref}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: thread.id, to: ref });
      }
    }
  }
  return edges;
}

function threadReferences(text = '') {
  const threadUrlPattern = THREAD_URL_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...String(text).matchAll(new RegExp(`(?:@|${threadUrlPattern}/)(T-[A-Za-z0-9-]+)`, 'g'))]
    .map((match) => match[1]);
}
