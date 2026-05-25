#!/usr/bin/env node
import { main, UsageError } from '../src/main.mjs';
import { CLI_NAME } from '../src/constants.mjs';

process.stdout.on('error', (error) => {
  if (error?.code === 'EPIPE') process.exit(0);
  throw error;
});

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`${CLI_NAME}: ${error.message}`);
    console.error(`Run \`${CLI_NAME} --help\` for usage.`);
    process.exit(2);
  }
  console.error(error.stack || String(error));
  process.exit(1);
});
