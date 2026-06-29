import type { Colorizer } from './color.js';
import type { RowGroup } from './group.js';
import type { StatusRow } from './row.js';
import type { FooterData } from '../shared/orchestrator-footer.js';
import type { Scope } from '../shared/scoping.js';

const COL_REPO = 20;
const COL_NUMBER = 5;
const COL_STATE = 8;
const COL_STUCK = 5;
const COL_SOURCE_LABEL = 30;
const COL_PR_NUMBER = 5;
const COL_CHECKS = 8;
const COL_TITLE = 60;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function fmtRow(row: StatusRow, colorizer: Colorizer): string {
  const repoCol = row.repo.padEnd(COL_REPO);
  const numCol = `#${String(row.number).padStart(COL_NUMBER)}`;
  const stateRaw = row.state.padEnd(COL_STATE);
  const stateCol = colorizer.state(stateRaw, row.state);
  const stuckRaw = (row.stuck ? 'STALE' : '').padEnd(COL_STUCK);
  const stuckCol = colorizer.stuck(stuckRaw, row.stuck);
  const sourceCol = row.sourceLabel.padEnd(COL_SOURCE_LABEL);
  const prCol = `PR ${row.prNumber == null ? '-'.padStart(COL_PR_NUMBER) : String(row.prNumber).padStart(COL_PR_NUMBER)}`;
  const checksCol = row.checks.padEnd(COL_CHECKS);
  const titleCol = truncate(row.title, COL_TITLE);
  return `${repoCol}   ${numCol}   ${stateCol}   ${stuckCol}   ${sourceCol}   ${prCol}   ${checksCol}   ${titleCol}`;
}

export interface StatusEnvelope {
  scope: { kind: 'epic'; owner: string; repo: string; issue: number } | { kind: 'repos'; repos: string[] };
  rows: StatusRow[];
  orchestrator:
    | { available: true; jobs: number; workers: number }
    | { available: false; reason: string };
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
  scope: Scope,
  rows: StatusRow[],
  footer: FooterData,
  epicIssue?: number,
): string {
  let scopeOut: StatusEnvelope['scope'];
  if (scope.kind === 'epic') {
    scopeOut = {
      kind: 'epic',
      owner: scope.owner,
      repo: scope.repo,
      issue: epicIssue ?? 0,
    };
  } else {
    scopeOut = { kind: 'repos', repos: scope.repos };
  }
  const orchestrator: StatusEnvelope['orchestrator'] = footer.available
    ? { available: true, jobs: footer.jobs ?? 0, workers: footer.workers ?? 0 }
    : { available: false, reason: footer.reason ?? 'unknown' };
  const envelope: StatusEnvelope = { scope: scopeOut, rows, orchestrator };
  return JSON.stringify(envelope);
}
