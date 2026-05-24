import { randomUUID } from 'node:crypto';
import {
  latestActiveThread,
  listThreads,
  requireThread,
  threadSearchText,
  writeThread,
} from '../threads/store.mjs';
import { runExecute } from '../cli/execute.mjs';
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
      .map((thread) => [thread.id, thread.archived ? 'archived' : 'active', thread.title]);
    printRows(rows.length ? rows : [['(none)', '-', '-']]);
    return;
  }

  if (subcommand === 'show') {
    const thread = requireThread(args[1]);
    console.log(`thread_id: ${thread.id}`);
    console.log(`url: https://ampcode.com/threads/${thread.id}`);
    console.log(`status: ${thread.archived ? 'archived' : 'active'}`);
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
      .map((thread) => [thread.id, thread.archived ? 'archived' : 'active', thread.title]);
    printRows(rows.length ? rows : [['(none)', '-', '-']]);
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

  if (subcommand === 'handoff') {
    const thread = requireThread(args[1]);
    const goalIndex = args.indexOf('--goal');
    const goal = goalIndex === -1 ? args.slice(2).join(' ') : args.slice(goalIndex + 1).join(' ');
    console.log('Handoff from parent thread');
    console.log(`Parent: https://ampcode.com/threads/${thread.id}`);
    console.log(`Goal: ${goal || 'Continue from the referenced thread.'}`);
    console.log('');
    console.log('Relevant context:');
    console.log(thread.messages.map((message) => `${message.role}: ${message.content}`).join('\n'));
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
