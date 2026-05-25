import { UsageError } from '../cli/parse.mjs';

export function runIde(args = []) {
  const subcommand = args[0] ?? 'connect';
  if (subcommand !== 'connect') throw new UsageError(`Unknown ide command: ${subcommand}`);
  runIdeConnect(args[1] ?? 'auto');
}

export function runIdeConnect(name) {
  console.log(`ide: ${name}`);
  console.log('status: unavailable (local recreation)');
  if (name === 'jetbrains') {
    console.log('hint: run Coven Code from the JetBrains terminal or install the Coven Code IDE plugin');
  } else {
    console.log('hint: run Coven Code from a supported IDE terminal or install the Coven Code IDE plugin');
  }
}
