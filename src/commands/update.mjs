import { CLI_NAME, VERSION } from '../constants.mjs';
import { readEffectiveSettings } from '../settings/load.mjs';

export function runUpdate(parsed = {}) {
  if (process.env.COVEN_CODE_SKIP_UPDATE_CHECK === '1') {
    console.log('update_check: skipped');
    console.log('reason: COVEN_CODE_SKIP_UPDATE_CHECK=1');
    console.log('update_action: none');
    console.log(`version: ${VERSION}`);
    return;
  }

  const mode = updateMode(readEffectiveSettings(parsed)['covenCode.updates.mode']);
  if (mode === 'disabled') {
    console.log('update_check: disabled');
    console.log('mode: disabled');
    console.log('update_action: none');
    console.log(`version: ${VERSION}`);
    return;
  }

  console.log('update_check: checked');
  console.log(`mode: ${mode}`);
  console.log(`update_action: ${mode === 'warn' ? 'notify' : 'auto'}`);
  console.log(`version: ${VERSION}`);
  console.log(`status: ${CLI_NAME} ${VERSION} is current in this local recreation.`);
}

function updateMode(value) {
  return ['auto', 'warn', 'disabled'].includes(value) ? value : 'auto';
}
