import { CLI_NAME } from '../constants.mjs';
import { runInteractive } from './repl.mjs';
import { formatSlashCommandDetails } from './slash-commands.mjs';
import {
  PALETTE_ACTIONS,
  currentSlashMatches,
  renderCompactStatus,
  renderComposerLines,
  renderTabContent,
  renderTabLine,
} from './tui-render.mjs';

export async function runLiveTui(model, session, handleKey) {
  try {
    const blessedModule = await import('neo-blessed');
    return runBlessedTui(blessedModule.default ?? blessedModule, model, session, handleKey);
  } catch (error) {
    console.error(`${CLI_NAME}: unable to start panel TUI, falling back to classic REPL: ${error?.message ?? error}`);
    return runInteractive(session.parsed, '');
  }
}

function runBlessedTui(blessed, model, session, handleKey) {
  return new Promise((resolve) => {
    const screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      title: `${CLI_NAME} ${model.version}`,
    });
    const header = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 4,
      padding: { left: 1, right: 1 },
      style: { fg: 'white', bg: 'black' },
    });
    const transcript = blessed.box({
      top: 4,
      left: 0,
      width: '100%',
      bottom: 4,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      padding: { left: 1, right: 1 },
      scrollbar: { ch: ' ', style: { bg: 'white' } },
    });
    const composer = blessed.box({
      bottom: 1,
      left: 0,
      width: '100%',
      height: 3,
      label: ' message ',
      border: 'line',
      padding: { left: 1, right: 1 },
      style: {
        border: { fg: 'green' },
      },
    });
    const status = blessed.box({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: { fg: 'white', bg: 'black' },
    });
    const palette = blessed.list({
      top: 'center',
      left: 'center',
      width: '60%',
      height: Math.min(13, PALETTE_ACTIONS.length + 2),
      label: ' Command Palette ',
      border: 'line',
      hidden: true,
      keys: true,
      mouse: true,
      items: PALETTE_ACTIONS.map(([label, command]) => `${label}  ${command}`),
      style: {
        border: { fg: 'yellow' },
        selected: { bg: 'blue', fg: 'white' },
      },
    });
    const slashList = blessed.list({
      bottom: 4,
      left: 0,
      width: '36%',
      height: '50%',
      label: ' Slash commands ',
      border: 'line',
      hidden: true,
      keys: true,
      mouse: true,
      style: {
        border: { fg: 'cyan' },
        selected: { bg: 'blue', fg: 'white' },
      },
    });
    const slashDetails = blessed.box({
      bottom: 4,
      right: 0,
      width: '64%',
      height: '50%',
      label: ' Details ',
      border: 'line',
      hidden: true,
      padding: { left: 1, right: 1 },
      style: {
        border: { fg: 'cyan' },
      },
    });

    screen.append(header);
    screen.append(transcript);
    screen.append(composer);
    screen.append(status);
    screen.append(palette);
    screen.append(slashList);
    screen.append(slashDetails);

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      screen.destroy();
      resolve();
    };
    const sync = () => {
      const width = Number(screen.width) || 80;
      header.setContent(`Coven Code ${model.version}\n${model.cwd}\n${renderTabLine(model)}   mode: ${model.mode}   effort: ${model.reasoningEffort}`);
      transcript.setContent(renderTabContent(model, Math.max(1, Number(transcript.height) - 2), Math.max(20, width - 4)).join('\n'));
      composer.setContent(renderComposerLines(model, width - 4, { cursor: true }).join('\n'));
      status.setContent(renderCompactStatus(model));
      if (model.paletteOpen) {
        palette.show();
        palette.select(model.paletteIndex);
        palette.focus();
      } else {
        palette.hide();
      }
      if (model.slashOpen) {
        const matches = currentSlashMatches(model);
        const selected = matches[model.slashIndex] ?? matches[0];
        slashList.setItems(matches.map((entry) => `${entry.command}  ${entry.title}`));
        slashList.show();
        slashList.select(model.slashIndex);
        slashDetails.setContent(formatSlashCommandDetails(selected).join('\n'));
        slashDetails.show();
      } else {
        slashList.hide();
        slashDetails.hide();
      }
      screen.render();
    };
    const dispatchKey = async (key) => {
      await handleKey(model, session, normalizeBlessedKey(key));
      sync();
      if (model.status === 'done') cleanup();
    };

    screen.on('keypress', async (chunk, key = {}) => {
      if (settled) return;
      const normalized = normalizeBlessedKey({
        ...key,
        sequence: isPrintableChunk(chunk, key) ? chunk : key.sequence,
      });
      await dispatchKey(normalized);
    });

    screen.on('resize', sync);
    sync();
  });
}

function normalizeBlessedKey(key = {}) {
  if (key.name === 'return') return { ...key, name: 'enter' };
  return key;
}

export function isPrintableKey(key = {}) {
  return isPrintableChunk(key.sequence, key);
}

function isPrintableChunk(chunk, key = {}) {
  return typeof chunk === 'string'
    && chunk.length > 0
    && !key.ctrl
    && !key.meta
    && key.name !== 'return'
    && key.name !== 'enter'
    && key.name !== 'tab'
    && key.name !== 'escape'
    && key.name !== 'up'
    && key.name !== 'down'
    && key.name !== 'left'
    && key.name !== 'right';
}
