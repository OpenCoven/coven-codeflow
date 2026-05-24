import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { settingsFile, workspaceSettingsFile } from '../settings/paths.mjs';
import { writeSettingsFile } from '../settings/load.mjs';
import { shellQuote } from '../util/shell.mjs';
import { UsageError } from '../cli/parse.mjs';

export async function runConfig(args, parsed = {}) {
  const subcommand = args[0] ?? 'edit';
  if (subcommand !== 'edit') throw new UsageError(`Unknown config command: ${subcommand}`);

  const workspace = args.includes('--workspace');
  const filePath = workspace ? workspaceSettingsFile(process.cwd()) : settingsFile(parsed);
  if (!existsSync(filePath)) await writeSettingsFile(filePath, {});

  const editor = process.env.EDITOR || process.env.VISUAL;
  if (!editor) throw new UsageError('config edit requires $EDITOR or $VISUAL');

  const result = spawnSync(`${editor} ${shellQuote(filePath)}`, {
    stdio: 'inherit',
    shell: true,
  });
  if (result.error) throw new UsageError(`Unable to run editor: ${result.error.message}`);
  if ((result.status ?? 0) !== 0) throw new UsageError(`Editor exited with status ${result.status}`);
}
