import { isPrintableKey } from './tui-blessed.mjs';
import {
  acceptSlashSelection,
  closeSlashMenu,
  completeSlashSelection,
  deleteComposerText,
  insertComposerText,
} from './tui-actions.mjs';
import { PALETTE_ACTIONS } from './tui-render.mjs';
import { submitTuiText } from './tui-submit.mjs';

export function handleComposerKey(model, key) {
  if (isPrintableKey(key)) {
    insertComposerText(model, key.sequence);
    return true;
  }
  if (key.name === 'backspace' || key.name === 'delete') {
    deleteComposerText(model, key.name);
    return true;
  }
  if (key.name === 'left') {
    model.composerCursor = Math.max(0, model.composerCursor - 1);
    return true;
  }
  if (key.name === 'right') {
    model.composerCursor = Math.min(model.composer.length, model.composerCursor + 1);
    return true;
  }
  if (key.name === 'home') {
    model.composerCursor = 0;
    return true;
  }
  if (key.name === 'end') {
    model.composerCursor = model.composer.length;
    return true;
  }
  return false;
}

export async function handleSlashMenuKey(model, session, key) {
  if (key.name === 'escape') {
    closeSlashMenu(model);
    return true;
  }
  if (key.name === 'down') {
    model.slashIndex = (model.slashIndex + 1) % Math.max(1, model.slashMatches.length);
    return true;
  }
  if (key.name === 'up') {
    model.slashIndex = (model.slashIndex + Math.max(1, model.slashMatches.length) - 1) % Math.max(1, model.slashMatches.length);
    return true;
  }
  if (key.name === 'tab') {
    completeSlashSelection(model);
    return true;
  }
  if (key.name === 'enter') {
    await acceptSlashSelection(model, session);
    return true;
  }
  return false;
}

export async function handlePaletteKey(model, session, key) {
  if (key.name === 'enter') {
    const [, command] = PALETTE_ACTIONS[model.paletteIndex ?? 0] ?? PALETTE_ACTIONS[0];
    model.paletteOpen = false;
    await submitTuiText(model, session, command);
    return true;
  }
  if (key.name === 'down') {
    model.paletteIndex = (model.paletteIndex + 1) % PALETTE_ACTIONS.length;
    return true;
  }
  if (key.name === 'up') {
    model.paletteIndex = (model.paletteIndex + PALETTE_ACTIONS.length - 1) % PALETTE_ACTIONS.length;
    return true;
  }
  return false;
}
