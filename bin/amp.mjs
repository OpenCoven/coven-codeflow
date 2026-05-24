#!/usr/bin/env node
import { main, UsageError } from '../src/main.mjs';

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`amp: ${error.message}`);
    console.error('Run `amp --help` for usage.');
    process.exit(2);
  }
  console.error(error.stack || String(error));
  process.exit(1);
});
