import { runInteractive } from './repl.mjs';
import { VERSION } from '../constants.mjs';
import { createInteractiveSession } from './interactive-core.mjs';
import { defaultLaneState } from '../agent/lane.mjs';
import { displayCwd } from '../util/fs.mjs';
import {
  buildStaticSlashCommandCatalog,
  filterSlashCommands,
} from './slash-commands.mjs';
import {
  TABS,
  buildPanelSummaries,
  renderCompactStatus,
  renderComposerLines,
  renderSlashOverlay,
  renderTabContent,
  renderTabLine,
} from './tui-render.mjs';
import { runLiveTui } from './tui-blessed.mjs';
import {
  closeSlashMenu,
  insertComposerText,
  safeBuildSlashCommandCatalog,
  updateSlashState,
} from './tui-actions.mjs';
import { submitTuiText } from './tui-submit.mjs';
import {
  handleComposerKey,
  handlePaletteKey,
  handleSlashMenuKey,
} from './tui-keys.mjs';

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
  return runLiveTui(model, session, handleTuiKey);
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

  if (handleComposerKey(model, key)) return;
  if (model.slashOpen && await handleSlashMenuKey(model, session, key)) return;

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

  if (model.paletteOpen && await handlePaletteKey(model, session, key)) return;

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
