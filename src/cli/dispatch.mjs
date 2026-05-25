import { printHelp } from './help.mjs';
import { UsageError } from './parse.mjs';
import { runLogin } from '../commands/login.mjs';
import { runUpdate } from '../commands/update.mjs';
import { runReview } from '../commands/review.mjs';
import { runUsage } from '../commands/usage.mjs';
import { runTools } from '../commands/tools.mjs';
import { runPermissions } from '../commands/permissions.mjs';
import { runConfig } from '../commands/config.mjs';
import { runAgents } from '../commands/agents.mjs';
import { runPlugins } from '../commands/plugins.mjs';
import { runMcp } from '../commands/mcp.mjs';
import { runSkill } from '../commands/skill.mjs';
import { runThreads } from '../commands/threads.mjs';
import { runIde } from '../commands/ide.mjs';

export async function runCommand(command, args, parsed, stdin) {
  switch (command) {
    case 'help':
      printHelp();
      break;
    case 'login':
      await runLogin(args);
      break;
    case 'update':
      runUpdate(parsed);
      break;
    case 'review':
      runReview();
      break;
    case 'usage':
      runUsage(parsed);
      break;
    case 'tools':
      await runTools(args, stdin, parsed);
      break;
    case 'permissions':
      await runPermissions(args, stdin, parsed);
      break;
    case 'config':
      await runConfig(args, parsed);
      break;
    case 'agents':
    case 'agents-md':
      await runAgents(args);
      break;
    case 'plugins':
      await runPlugins(args);
      break;
    case 'mcp':
      await runMcp(args, parsed);
      break;
    case 'skill':
      await runSkill(args, parsed);
      break;
    case 'threads':
      await runThreads(args, parsed, stdin);
      break;
    case 'ide':
      runIde(args);
      break;
    default:
      if (parsed.help) printHelp();
      else throw new UsageError(`Unknown command: ${command}`);
  }
}
