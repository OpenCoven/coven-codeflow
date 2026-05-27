import { CLI_NAME } from '../constants.mjs';
import {
  inspectLane,
  nextLaneHarness,
  normalizeLaneHarness,
  runLaneVerification,
} from '../agent/lane.mjs';
import { splitShellWords } from '../util/shell.mjs';
import { renderLaneLines } from './tui-render.mjs';

export function isLaneCommand(text) {
  return /^\/lane(?:\s|$)/.test(text);
}

export async function handleTuiLaneCommand(model, session, text) {
  try {
    const [, subcommand = 'status', ...rest] = splitShellWords(text.slice(1));
    if (subcommand === 'refresh') {
      const inspector = session.laneInspector ?? inspectLane;
      model.lane = await inspector({
        cwd: process.cwd(),
        harness: model.lane.harness,
        verification: model.lane.verification,
      });
      model.activeTab = 'lane';
      return laneCommandResult(`lane refreshed: ${model.lane.branch}`);
    }
    if (subcommand === 'harness') {
      const requested = rest[0] === 'next' ? nextLaneHarness(model.lane.harness) : rest[0];
      const harness = normalizeLaneHarness(requested);
      model.lane = { ...model.lane, harness };
      model.activeTab = 'lane';
      return laneCommandResult(`harness: ${harness}`);
    }
    if (subcommand === 'verify') {
      const verifier = session.laneVerifier ?? runLaneVerification;
      model.lane = await verifier(model.lane);
      model.activeTab = 'lane';
      return laneCommandResult(`verification: ${model.lane.verification.status}`);
    }
    if (subcommand === 'diff') {
      model.activeTab = 'lane';
      return laneCommandResult(model.lane.diffSummary || 'no diff summary');
    }
    if (subcommand === 'status') {
      model.activeTab = 'lane';
      return laneCommandResult(renderLaneLines(model, 40, 120).join('\n'));
    }
    return laneCommandResult(`${CLI_NAME}: Unknown lane command: ${subcommand}`, 'error');
  } catch (error) {
    return laneCommandResult(`${CLI_NAME}: ${error?.message ?? error}`, 'error');
  }
}

function laneCommandResult(text, kind = 'command') {
  return {
    result: { kind, lines: [text] },
    stdout: '',
    stderr: '',
  };
}

export function rememberLaneTerminal(model, stdout, stderr, resultLines = []) {
  const lines = [stdout, stderr, resultLines.join('\n')]
    .flatMap((text) => String(text ?? '').split(/\r?\n/))
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (lines.length === 0) return;
  model.lane = {
    ...model.lane,
    terminalLines: [...(model.lane.terminalLines ?? []), ...lines].slice(-40),
  };
}
