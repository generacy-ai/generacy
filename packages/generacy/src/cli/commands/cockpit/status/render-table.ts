import type { Colorizer } from './color.js';
import type { RowGroup } from './group.js';
import type { StatusRow } from './row.js';

const COL_REPO = 20;
const COL_NUMBER = 5;
const COL_STATE = 8;
const COL_SOURCE_LABEL = 30;
const COL_PR_NUMBER = 5;
const COL_CHECKS = 8;
const COL_TITLE = 60;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Renders a single row. Closed rows swap the state + source columns to convey
 * "done" per `data-model.md`. The invariant carrier is `isDoneSnapshot`
 * (`shared/is-done-snapshot.ts`) — the branch below is the single render-layer
 * consumer of `StatusRow.issueState`.
 *
 * @see isDoneSnapshot
 */
function fmtRow(row: StatusRow, colorizer: Colorizer): string {
  const repoCol = row.repo.padEnd(COL_REPO);
  const numCol = `#${String(row.number).padStart(COL_NUMBER)}`;
  let stateCol: string;
  let sourceCol: string;
  if (row.issueState === 'CLOSED') {
    if (row.stateReason === 'NOT_PLANNED') {
      stateCol = colorizer.doneNotPlanned('✗ closed'.padEnd(COL_STATE));
      sourceCol = colorizer.doneNotPlanned('(not planned)'.padEnd(COL_SOURCE_LABEL));
    } else {
      stateCol = colorizer.doneMerged('✓ merged'.padEnd(COL_STATE));
      sourceCol = colorizer.doneMerged('merged/closed'.padEnd(COL_SOURCE_LABEL));
    }
  } else {
    const stateRaw = row.state.padEnd(COL_STATE);
    stateCol = colorizer.state(stateRaw, row.state);
    sourceCol = row.sourceLabel.padEnd(COL_SOURCE_LABEL);
  }
  const prCol = `PR ${row.prNumber == null ? '-'.padStart(COL_PR_NUMBER) : String(row.prNumber).padStart(COL_PR_NUMBER)}`;
  const checksCol = row.checks.padEnd(COL_CHECKS);
  const titleCol = truncate(row.title, COL_TITLE);
  return `${repoCol}   ${numCol}   ${stateCol}   ${sourceCol}   ${prCol}   ${checksCol}   ${titleCol}`;
}

export interface StatusEnvelope {
  scope: { kind: 'epic'; owner: string; repo: string; issue: number };
  rows: StatusRow[];
  /**
   * #1006 (FR-012): additive, non-breaking. Verbatim copy of
   * `parsed.warnings` from the resolver; empty array on clean bodies.
   * See `specs/1006-summary-llm-authored-epic/data-model.md § StatusEnvelope`.
   */
  warnings: string[];
}

export interface RenderOptions {
  tty: boolean;
  json: boolean;
  colorizer: Colorizer;
}

export function renderTable(groups: RowGroup[], options: RenderOptions): string {
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    if (i > 0) lines.push('');
    lines.push(group.header);
    for (const row of group.rows) {
      lines.push(fmtRow(row, options.colorizer));
    }
  }
  return lines.join('\n');
}

export function renderJsonEnvelope(
  epic: { owner: string; repo: string; issue: number },
  rows: StatusRow[],
  warnings: string[],
): string {
  const envelope: StatusEnvelope = {
    scope: {
      kind: 'epic',
      owner: epic.owner,
      repo: epic.repo,
      issue: epic.issue,
    },
    rows,
    warnings,
  };
  return JSON.stringify(envelope);
}
