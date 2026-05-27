import { runCommand } from './dispatch.mjs';
import { runExecute } from './execute.mjs';
import { readEditorPrompt, submitPromptAndQueue } from './interactive-io.mjs';
import { handleSlashCommand, sessionSlashHelpLines } from './interactive-slash.mjs';

export function createInteractiveSession(parsed, options = {}) {
  return {
    parsed,
    thread: options.thread,
    cwd: options.cwd ?? process.cwd(),
    queuedMessages: [],
    silent: options.silent ?? false,
    commandRunner: options.commandRunner ?? runCommand,
    executeRunner: options.executeRunner ?? runExecute,
    editorReader: options.editorReader ?? readEditorPrompt,
  };
}

export async function handleInteractiveInput(session, text) {
  if (!text) return { kind: 'empty', lines: [] };
  if (text === '/exit' || text === '/quit') return { kind: 'exit', lines: [] };
  if (text === '/help') return { kind: 'help', lines: await sessionSlashHelpLines(session) };
  if (!text.startsWith('/')) {
    await submitPromptAndQueue(session, text);
    return { kind: 'turn', lines: [] };
  }
  return handleSlashCommand(session, text);
}
