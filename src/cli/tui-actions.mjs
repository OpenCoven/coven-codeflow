import {
  buildSlashCommandCatalog,
  buildStaticSlashCommandCatalog,
  filterSlashCommands,
} from './slash-commands.mjs';
import { currentSlashMatches } from './tui-render.mjs';
import { submitTuiText } from './tui-submit.mjs';

export function insertComposerText(model, text) {
  model.composer = `${model.composer.slice(0, model.composerCursor)}${text}${model.composer.slice(model.composerCursor)}`;
  model.composerCursor += text.length;
  updateSlashState(model);
}

export function deleteComposerText(model, kind) {
  if (kind === 'delete') {
    if (model.composerCursor >= model.composer.length) return;
    model.composer = `${model.composer.slice(0, model.composerCursor)}${model.composer.slice(model.composerCursor + 1)}`;
  } else {
    if (model.composerCursor <= 0) return;
    model.composer = `${model.composer.slice(0, model.composerCursor - 1)}${model.composer.slice(model.composerCursor)}`;
    model.composerCursor -= 1;
  }
  updateSlashState(model);
}

export function updateSlashState(model) {
  const beforeCursor = model.composer.slice(0, model.composerCursor);
  const active = beforeCursor.startsWith('/') && !/\s/.test(beforeCursor.slice(1));
  if (!active) {
    closeSlashMenu(model);
    return;
  }
  model.slashOpen = true;
  model.slashQuery = beforeCursor.replace(/^\/+/, '');
  model.slashMatches = filterSlashCommands(model.slashCatalog, beforeCursor);
  if (model.slashMatches.length === 0) model.slashIndex = 0;
  else model.slashIndex = Math.min(model.slashIndex, model.slashMatches.length - 1);
}

export function closeSlashMenu(model) {
  model.slashOpen = false;
  model.slashQuery = '';
  model.slashMatches = filterSlashCommands(model.slashCatalog, '');
  model.slashIndex = 0;
}

export function completeSlashSelection(model) {
  const selected = currentSlashMatches(model)[model.slashIndex];
  if (!selected) return;
  model.composer = `${selected.command} `;
  model.composerCursor = model.composer.length;
  closeSlashMenu(model);
}

export async function acceptSlashSelection(model, session) {
  const selected = currentSlashMatches(model)[model.slashIndex];
  if (!selected) return;
  const command = selected.command;
  model.composer = '';
  model.composerCursor = 0;
  closeSlashMenu(model);
  await submitTuiText(model, session, command);
}

export async function safeBuildSlashCommandCatalog(parsed) {
  try {
    return await buildSlashCommandCatalog({ parsed, cwd: process.cwd() });
  } catch {
    return buildStaticSlashCommandCatalog();
  }
}
