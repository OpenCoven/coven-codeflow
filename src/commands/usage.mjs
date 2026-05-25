import { listThreads } from '../threads/store.mjs';
import { estimateTokenCount } from '../agent/local.mjs';
import { readEffectiveSettings } from '../settings/load.mjs';

export function runUsage(parsed = {}) {
  const summary = localUsageSummary();
  const showCosts = readEffectiveSettings(parsed)['covenCode.showCosts'] !== false;
  if (showCosts) console.log('remote_balance: unavailable (local recreation)');
  console.log(`threads: ${summary.threads}`);
  console.log(`turns: ${summary.turns}`);
  if (showCosts) {
    console.log(`input_tokens_estimate: ${summary.inputTokens}`);
    console.log(`output_tokens_estimate: ${summary.outputTokens}`);
  }
}

function localUsageSummary() {
  const threads = listThreads();
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const thread of threads) {
    const messages = Array.isArray(thread.messages) ? thread.messages : [];
    for (const message of messages) {
      if (message.role === 'user') {
        turns += 1;
        inputTokens += estimateTokenCount(message.content ?? '');
      } else if (message.role === 'assistant') {
        outputTokens += estimateTokenCount(message.content ?? '');
      }
    }
  }
  return { threads: threads.length, turns, inputTokens, outputTokens };
}
