import { UsageError } from './parse.mjs';

const DEFAULT_REASONING_EFFORT_BY_MODE = {
  smart: 'high',
  deep: 'high',
  rush: 'minimal',
  large: 'high',
};

const REASONING_EFFORTS_BY_MODE = {
  smart: ['high', 'xhigh', 'max'],
  deep: ['high', 'low', 'medium', 'xhigh'],
  rush: ['minimal'],
  large: ['high', 'xhigh', 'max'],
};

export function reasoningEffortForMode(mode, requested) {
  const efforts = reasoningEffortsForMode(mode);
  if (requested === undefined || requested === null || requested === '') return defaultReasoningEffortForMode(mode);
  if (efforts.includes(requested)) return requested;
  throw new UsageError(`reasoning effort for ${mode} must be one of: ${efforts.join(', ')}`);
}

export function coerceReasoningEffortForMode(mode, requested) {
  try {
    return reasoningEffortForMode(mode, requested);
  } catch {
    return defaultReasoningEffortForMode(mode);
  }
}

export function nextReasoningEffortForMode(mode, requested) {
  const efforts = reasoningEffortsForMode(mode);
  const current = coerceReasoningEffortForMode(mode, requested);
  const index = efforts.indexOf(current);
  return efforts[(index + 1) % efforts.length];
}

function defaultReasoningEffortForMode(mode) {
  return DEFAULT_REASONING_EFFORT_BY_MODE[mode] ?? DEFAULT_REASONING_EFFORT_BY_MODE.smart;
}

function reasoningEffortsForMode(mode) {
  return REASONING_EFFORTS_BY_MODE[mode] ?? REASONING_EFFORTS_BY_MODE.smart;
}
