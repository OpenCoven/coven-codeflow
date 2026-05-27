import { existsSync } from 'node:fs';
import { readEffectiveSettings } from '../settings/load.mjs';
import { findWorkspaceSettingsFile, settingsFile } from '../settings/paths.mjs';
import { listThreads } from '../threads/store.mjs';
import {
  buildStaticSlashCommandCatalog,
  builtinToolSummaryLines,
  filterSlashCommands,
  formatSlashCommandDetails,
  formatSlashHelpLines,
} from './slash-commands.mjs';

export const TABS = ['chat', 'lane', 'tools', 'threads', 'config', 'help'];

export const PALETTE_ACTIONS = [
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

export function renderTabContent(model, limit, width) {
  if (model.activeTab === 'help') return clipLines(formatSlashHelpLines(model.slashCatalog), limit, width);
  if (model.activeTab === 'lane') return renderLaneLines(model, limit, width);
  if (model.activeTab === 'tools') return clipLines(model.panels.tools, limit, width);
  if (model.activeTab === 'threads') return clipLines(model.panels.threads, limit, width);
  if (model.activeTab === 'config') return clipLines(model.panels.config, limit, width);
  return renderTranscript(model, limit, width);
}

export function renderTranscript(model, limit, width) {
  const entries = model.transcript.slice(-Math.max(1, limit)).flatMap((entry) => [
    `${entry.role}:`,
    ...String(entry.text).split(/\r?\n/),
  ]);
  return clipLines(entries.length > 0 ? entries.slice(-limit) : ['Ready. Type a prompt or /help.'], limit, width);
}

export function renderComposerLines(model, width, { cursor = false } = {}) {
  const prompt = model.composer || '';
  const text = cursor ? insertComposerCursor(prompt, model.composerCursor ?? prompt.length) : prompt;
  const lines = String(text).split('\n');
  return lines.map((line, index) => `${index === 0 ? '> ' : '  '}${line}`.slice(0, width));
}

function insertComposerCursor(prompt, cursor) {
  const position = Math.max(0, Math.min(prompt.length, cursor));
  const before = prompt.slice(0, position);
  const at = prompt.slice(position, position + 1);
  const after = prompt.slice(position + 1);
  if (at === '\n' || at === '') return `${before}█${at}${after}`;
  return `${before}█${after}`;
}

export function renderSlashOverlay(model, width, limit) {
  const listWidth = Math.min(34, Math.floor(width * 0.38));
  const detailWidth = width - listWidth - 3;
  const matches = currentSlashMatches(model);
  const selected = matches[model.slashIndex] ?? matches[0];
  const listLines = ['Slash commands', ...matches.map((entry, index) => {
    const marker = index === model.slashIndex ? '>' : ' ';
    const status = entry.availability?.type === 'disabled' ? ' disabled' : '';
    return `${marker} ${entry.command}${status}`;
  })];
  const detailLines = ['Details', ...formatSlashCommandDetails(selected)];
  const count = Math.min(limit, Math.max(listLines.length, detailLines.length));
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const left = (listLines[index] ?? '').padEnd(listWidth).slice(0, listWidth);
    const right = (detailLines[index] ?? '').slice(0, detailWidth);
    rows.push(`${left} | ${right}`);
  }
  return rows;
}

export function renderCompactStatus(model) {
  return [
    `thread: ${shortThreadId(model.threadId)}`,
    `lane: ${model.lane.branch}`,
    `harness: ${model.lane.harness}`,
    `queued: ${model.queueCount}`,
    `tools: ${model.toolCount}`,
    `tab: ${model.activeTab}`,
    `status: ${model.status}`,
  ].join('  |  ');
}

export function buildPanelSummaries(parsed = {}, slashCatalog = buildStaticSlashCommandCatalog(), cwd = process.cwd()) {
  const threads = listThreads().slice(0, 8);
  const latest = threads
    .filter((thread) => !thread.archived)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  const settingsPath = settingsFile(parsed);
  const workspacePath = findWorkspaceSettingsFile(cwd);
  const settings = readEffectiveSettings(parsed, { cwd });
  return {
    tools: [
      ...builtinToolSummaryLines(),
      '',
      'Slash command sources:',
      `commands: ${slashCatalog.length}`,
    ],
    threads: [
      `Recent threads: ${threads.length}`,
      `Latest: ${latest?.id ?? 'none'}`,
      ...threads.map((thread) => `${thread.id} ${thread.archived ? 'archived' : 'active'} ${thread.title}`),
    ],
    config: [
      'Settings',
      `user: ${settingsPath}${existsSync(settingsPath) ? '' : ' (not created)'}`,
      `workspace: ${workspacePath ?? 'none'}`,
      `visibility: ${settings['covenCode.defaultVisibility'] ?? 'private'}`,
      `updates: ${settings['covenCode.updates.mode'] ?? 'default'}`,
    ],
  };
}

export function renderTabLine(model) {
  return TABS.map((tab) => tab === model.activeTab ? `[${tab}]` : ` ${tab} `).join(' ');
}

function clipLines(lines, limit, width) {
  return lines
    .slice(0, Math.max(0, limit))
    .map((line) => String(line).slice(0, width));
}

function shortThreadId(threadId) {
  if (!threadId || threadId === 'new thread') return 'new';
  return String(threadId).slice(0, 14);
}

export function renderLaneLines(model, limit, width) {
  const lane = model.lane;
  const changedFiles = lane.changedFiles.length > 0 ? lane.changedFiles : ['none'];
  const lines = [
    `worktree: ${lane.worktree}`,
    `branch: ${lane.branch}`,
    `base: ${lane.baseBranch}`,
    `harness: ${lane.harness}`,
    `status: ${lane.status}`,
    `verify: ${lane.verification.status} (${lane.verification.command})`,
    `PR: ${lane.pullRequest}`,
    `merge: ${lane.merge}`,
    `cleanup: ${lane.cleanup}`,
    '',
    'Changed files',
    ...changedFiles.map((file) => `  ${file}`),
    '',
    'Diff',
    lane.diffSummary || '  no diff summary',
    '',
    'Terminal',
    ...(lane.terminalLines.length > 0 ? lane.terminalLines : ['  no lane terminal output yet']),
  ];
  return lines.slice(0, limit).map((line) => line.slice(0, width));
}

export function currentSlashMatches(model) {
  return model.slashMatches.length > 0 ? model.slashMatches : filterSlashCommands(model.slashCatalog, model.slashQuery);
}
