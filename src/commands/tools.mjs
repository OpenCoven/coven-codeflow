import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BUILTIN_TOOLS } from '../constants.mjs';
import { writableToolsDir } from '../settings/paths.mjs';
import { listConfiguredMcpServers } from '../mcp/discover.mjs';
import { discoverMcpToolRows } from '../mcp/probe.mjs';
import { listPluginTools } from '../plugins/discover.mjs';
import {
  executeToolboxTool,
  isToolDisabled,
  listToolboxTools,
  normalizeToolName,
  parseToolUseArgs,
  printToolboxSchema,
  toolboxTemplate,
} from '../tools/toolbox.mjs';
import { UsageError } from '../cli/parse.mjs';
import { printRows } from '../util/table.mjs';

export async function runTools(args, stdin, parsed = {}) {
  const subcommand = args[0] ?? 'list';
  if (subcommand === 'list') {
    const mcpToolRows = discoverMcpToolRows(
      listConfiguredMcpServers(parsed).filter((server) => server.status === 'approved'),
    );
    const pluginToolRows = (await listPluginTools(process.cwd()))
      .map((tool) => [tool.name, 'plugin', tool.description]);
    const rows = [
      ...BUILTIN_TOOLS,
      ...mcpToolRows,
      ...pluginToolRows,
      ...listToolboxTools().map((tool) => [tool.name, 'toolbox', tool.description]),
    ].filter(([name, kind]) => !isToolDisabled(name, kind, parsed));
    printRows(rows);
    return;
  }

  if (subcommand === 'make') {
    const shell = args.includes('--zsh') ? 'zsh' : 'bash';
    const rawName = args.find((arg) => !arg.startsWith('-') && arg !== 'make') ?? 'tool';
    const toolName = rawName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(writableToolsDir(), toolName);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, toolboxTemplate(shell, toolName), 'utf8');
    await chmod(filePath, 0o755);
    console.log(`Tool created at: ${filePath}`);
    console.log(`Inspect with: amp tools show tb__${toolName}`);
    console.log(`Execute with: amp tools use tb__${toolName}`);
    return;
  }

  if (subcommand === 'show') {
    const toolName = normalizeToolName(args[1]);
    const tool = listToolboxTools().find((entry) => entry.name === toolName);
    if (!tool) throw new UsageError(`Unknown tool: ${args[1] ?? ''}`);
    printToolboxSchema(tool);
    return;
  }

  if (subcommand === 'use') {
    const useArgs = parseToolUseArgs(args.slice(1));
    const toolName = normalizeToolName(useArgs.toolName);
    const tool = listToolboxTools().find((entry) => entry.name === toolName);
    if (!tool) throw new UsageError(`Unknown tool: ${useArgs.toolName ?? ''}`);
    const result = executeToolboxTool(tool, useArgs.flags, stdin, useArgs.threadId);
    if (useArgs.onlyOutput) {
      process.stdout.write(result.stdout);
    } else {
      if (result.stderr) process.stderr.write(result.stderr);
      process.stdout.write(`${JSON.stringify({ output: result.stdout, exitCode: result.status ?? 0 }, null, 2)}\n`);
    }
    process.exitCode = result.status ?? 0;
    return;
  }

  throw new UsageError(`Unknown tools command: ${subcommand}`);
}
