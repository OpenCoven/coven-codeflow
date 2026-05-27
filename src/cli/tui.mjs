import { runInteractive } from './repl.mjs';
import { CLI_NAME, VERSION } from '../constants.mjs';
import { createInteractiveSession } from './interactive-core.mjs';
import { defaultLaneState } from '../agent/lane.mjs';
import { displayCwd } from '../util/fs.mjs';
import {
  buildStaticSlashCommandCatalog,
  filterSlashCommands,
  formatSlashCommandDetails,
} from './slash-commands.mjs';
import {
  TABS,
  buildPanelSummaries,
  currentSlashMatches,
  renderCompactStatus,
  renderComposerLines,
  renderSlashOverlay,
  renderTabContent,
  renderTabLine,
} from './tui-render.mjs';
import {
  acceptSlashSelection,
  closeSlashMenu,
  completeSlashSelection,
  deleteComposerText,
  insertComposerText,
  safeBuildSlashCommandCatalog,
  submitTuiText,
  updateSlashState,
} from './tui-actions.mjs';

const PALETTE_ACTIONS = [
  ['New thread', '/new'],
  ['Continue latest thread', '/continue'],
  ['Refresh lane', '/lane refresh'],
  ['Cycle harness', '/lane harness next'],
  ['Run verification', '/lane verify'],
  ['Open help', '/help'],
  ['List tools', '/tools list'],
  ['List skills', '/skill: list'],
  ['List plugins', '/plugins: list'],
  ['Open editor', '/editor'],
  ['Edit previous prompt', '/edit'],
  ['Archive and quit', '/thread: archive and quit'],
];

export async function runTuiInteractive(parsed, initialInput = '') {
  const session = createInteractiveSession(parsed, { silent: true });
  const slashCatalog = await safeBuildSlashCommandCatalog(parsed);
  const model = createTuiModel({
    mode: parsed.mode,
    reasoningEffort: parsed.reasoningEffort,
    slashCatalog,
    parsed,
  });
  if (process.env.COVEN_CODE_TUI_SCRIPTED === '1') {
    for (const line of initialInput.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      await submitTuiText(model, session, text);
      if (model.status === 'done') break;
    }
    console.log(renderTuiFrame(model, { columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }));
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) return runInteractive(parsed, initialInput);
  return runLiveTui(model, session);
}

export function createTuiModel(options = {}) {
  const slashCatalog = options.slashCatalog ?? buildStaticSlashCommandCatalog();
  const composer = options.composer ?? '';
  const workspaceCwd = options.cwd ?? process.cwd();
  const model = {
    version: options.version ?? VERSION,
    cwd: displayCwd(workspaceCwd),
    workspaceCwd,
    mode: options.mode ?? 'smart',
    reasoningEffort: options.reasoningEffort ?? 'high',
    threadId: options.threadId ?? 'new thread',
    toolCount: options.toolCount ?? 0,
    queueCount: options.queueCount ?? 0,
    activeTab: options.activeTab ?? 'chat',
    paletteOpen: false,
    paletteIndex: 0,
    composer,
    composerCursor: options.composerCursor ?? composer.length,
    multiline: false,
    slashCatalog,
    slashOpen: false,
    slashIndex: 0,
    slashQuery: '',
    slashMatches: filterSlashCommands(slashCatalog, ''),
    transcript: [],
    lane: defaultLaneState({ harness: options.mode ?? 'smart', ...options.lane }),
    status: 'idle',
    panels: options.panels ?? buildPanelSummaries(options.parsed, slashCatalog, workspaceCwd),
  };
  updateSlashState(model);
  return model;
}

export function renderTuiFrame(model, size = {}) {
  const columns = Math.max(50, size.columns ?? process.stdout.columns ?? 80);
  const rows = Math.max(16, size.rows ?? process.stdout.rows ?? 24);
  const divider = '-'.repeat(columns);
  const header = [
    `Coven Code ${model.version}`.slice(0, columns),
    `${model.cwd}`.slice(0, columns),
    `${renderTabLine(model)}   mode: ${model.mode}   effort: ${model.reasoningEffort}`.slice(0, columns),
    divider,
  ];
  const status = renderCompactStatus(model).slice(0, columns);
  const composerLines = renderComposerLines(model, columns);
  const slashLines = model.slashOpen ? renderSlashOverlay(model, columns, Math.min(10, Math.max(4, rows - 10))) : [];
  const footer = [
    divider,
    ...composerLines,
    ...slashLines,
    status,
  ];
  const bodyRows = Math.max(1, rows - header.length - footer.length);
  const body = renderTabContent(model, bodyRows, columns);
  return [
    ...header,
    ...body,
    ...footer,
  ].slice(0, rows).join('\n');
}

export async function handleTuiKey(model, session, key = {}) {
  if (key.ctrl && key.name === 'c') {
    model.status = 'done';
    return;
  }

  if (isPrintableKey(key)) {
    insertComposerText(model, key.sequence);
    return;
  }

  if (key.name === 'backspace' || key.name === 'delete') {
    deleteComposerText(model, key.name);
    return;
  }

  if (key.name === 'left') {
    model.composerCursor = Math.max(0, model.composerCursor - 1);
    return;
  }

  if (key.name === 'right') {
    model.composerCursor = Math.min(model.composer.length, model.composerCursor + 1);
    return;
  }

  if (key.name === 'home') {
    model.composerCursor = 0;
    return;
  }

  if (key.name === 'end') {
    model.composerCursor = model.composer.length;
    return;
  }

  if (model.slashOpen) {
    if (key.name === 'escape') {
      closeSlashMenu(model);
      return;
    }
    if (key.name === 'down') {
      model.slashIndex = (model.slashIndex + 1) % Math.max(1, model.slashMatches.length);
      return;
    }
    if (key.name === 'up') {
      model.slashIndex = (model.slashIndex + Math.max(1, model.slashMatches.length) - 1) % Math.max(1, model.slashMatches.length);
      return;
    }
    if (key.name === 'tab') {
      completeSlashSelection(model);
      return;
    }
    if (key.name === 'enter') {
      await acceptSlashSelection(model, session);
      return;
    }
  }

  if (key.name === 'tab') {
    const index = TABS.indexOf(model.activeTab);
    model.activeTab = TABS[(index + 1) % TABS.length];
    return;
  }

  if (key.name === 'escape') {
    model.paletteOpen = false;
    return;
  }

  if (key.ctrl && key.name === 'p') {
    model.paletteOpen = true;
    model.paletteIndex = 0;
    return;
  }

  if (model.paletteOpen && key.name === 'enter') {
    const [, command] = PALETTE_ACTIONS[model.paletteIndex ?? 0] ?? PALETTE_ACTIONS[0];
    model.paletteOpen = false;
    await submitTuiText(model, session, command);
    return;
  }

  if (model.paletteOpen && key.name === 'down') {
    model.paletteIndex = (model.paletteIndex + 1) % PALETTE_ACTIONS.length;
    return;
  }

  if (model.paletteOpen && key.name === 'up') {
    model.paletteIndex = (model.paletteIndex + PALETTE_ACTIONS.length - 1) % PALETTE_ACTIONS.length;
    return;
  }

  if (key.ctrl && key.name === 'n') {
    await submitTuiText(model, session, '/new');
    return;
  }

  if (key.ctrl && key.name === 'r') {
    await submitTuiText(model, session, '/reasoning next');
    return;
  }

  if (key.ctrl && key.name === 'm') {
    const next = session.parsed.mode === 'smart' ? 'deep' : session.parsed.mode === 'deep' ? 'rush' : 'smart';
    await submitTuiText(model, session, `/mode ${next}`);
    return;
  }

  if ((key.meta || key.shift) && key.name === 'enter') {
    insertComposerText(model, '\n');
    model.multiline = true;
    return;
  }

  if (key.name === 'enter') {
    const text = model.composer.trim();
    model.composer = '';
    model.composerCursor = 0;
    closeSlashMenu(model);
    await submitTuiText(model, session, text);
  }
}

async function runLiveTui(model, session) {
  try {
    const blessedModule = await import('neo-blessed');
    return runBlessedTui(blessedModule.default ?? blessedModule, model, session);
  } catch (error) {
    console.error(`${CLI_NAME}: unable to start panel TUI, falling back to classic REPL: ${error?.message ?? error}`);
    return runInteractive(session.parsed, '');
  }
}

function runBlessedTui(blessed, model, session) {
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
      await handleTuiKey(model, session, normalizeBlessedKey(key));
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

function isPrintableKey(key = {}) {
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
