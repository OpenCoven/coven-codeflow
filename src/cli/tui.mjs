import { runInteractive } from './repl.mjs';

export async function runTuiInteractive(parsed, initialInput = '') {
  return runInteractive(parsed, initialInput);
}
