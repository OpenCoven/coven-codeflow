import { readEffectiveSettings } from '../settings/load.mjs';

export function notifyAgentComplete(parsed = {}) {
  if (readEffectiveSettings(parsed)['covenCode.notifications.enabled'] === false) return;
  if (!shouldUseTerminalBell()) return;
  process.stderr.write('\x07');
}

function shouldUseTerminalBell() {
  return process.env.COVEN_CODE_FORCE_BEL === '1'
    || process.env.COVEN_CODE_FORCE_BEL === 'true'
    || Boolean(process.env.SSH_TTY || process.env.SSH_CONNECTION);
}
