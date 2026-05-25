#!/usr/bin/env node
import { runInstallCommand } from '../src/sdk-install.mjs';

runInstallCommand(process.argv.slice(2))
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
