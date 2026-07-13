import { describe, expect, it } from 'vitest';
import type { CockpitState, ParsedPhase } from '@generacy-ai/cockpit';
import { renderTable } from '../status/render-table.js';
import { groupRows } from '../status/group.js';
import type { Colorizer } from '../status/color.js';
import type { StatusRow } from '../status/row.js';

function row(overrides: Partial<StatusRow> = {}): StatusRow {
  return {
    repo: 'o/r',
    kind: 'issue',
    number: 1,
    title: 'X',
    state: 'active',
    sourceLabel: 'phase:plan',
    issueState: 'OPEN',
    stateReason: null,
    prNumber: null,
    checks: 'none',
    url: 'https://github.com/o/r/issues/1',
    phase: null,
    ...overrides,
  };
}

function phasesFor(rows: StatusRow[]): ParsedPhase[] {
  return [
    {
      heading: 'P1',
      token: 'p1',
      refs: rows.map((r) => ({ repo: r.repo, number: r.number })),
    },
  ];
}

interface SentinelCalls {
  state: Array<{ s: string; state: CockpitState }>;
  doneMerged: string[];
  doneNotPlanned: string[];
}

function sentinelColorizer(): {
  colorizer: Colorizer;
  calls: SentinelCalls;
} {
  const calls: SentinelCalls = { state: [], doneMerged: [], doneNotPlanned: [] };
  return {
    colorizer: {
      state(s, state) {
        calls.state.push({ s, state });
        return `<${state}>${s}</${state}>`;
      },
      doneMerged(s) {
        calls.doneMerged.push(s);
        return `<merged>${s}</merged>`;
      },
      doneNotPlanned(s) {
        calls.doneNotPlanned.push(s);
        return `<notplanned>${s}</notplanned>`;
      },
    },
    calls,
  };
}

describe('status color application', () => {
  it('applies the colorizer to the state column only', () => {
    const { colorizer, calls } = sentinelColorizer();
    const rows = [row({ phase: 'p1' })];
    const out = renderTable(
      groupRows(rows, phasesFor(rows), 'o/r'),
      { tty: true, json: false, colorizer },
    );
    expect(calls.state).toHaveLength(1);
    expect(calls.state[0]?.state).toBe('active');
    expect(out).toContain('<active>');
    expect(out).not.toContain('<terminal>');
  });

  it('passes the correct state value per row', () => {
    const { colorizer, calls } = sentinelColorizer();
    const rows: StatusRow[] = [
      row({ number: 1, state: 'terminal', phase: 'p1' }),
      row({ number: 2, state: 'error', phase: 'p1' }),
      row({ number: 3, state: 'waiting', phase: 'p1' }),
      row({ number: 4, state: 'pending', phase: 'p1' }),
      row({ number: 5, state: 'unknown', phase: 'p1' }),
    ];
    renderTable(
      groupRows(rows, phasesFor(rows), 'o/r'),
      { tty: true, json: false, colorizer },
    );
    expect(calls.state.map((c) => c.state)).toEqual([
      'terminal',
      'error',
      'waiting',
      'pending',
      'unknown',
    ]);
  });

  it('#873: closed + COMPLETED routes through doneMerged, not colorizer.state', () => {
    const { colorizer, calls } = sentinelColorizer();
    const rows = [
      row({
        phase: 'p1',
        state: 'terminal',
        sourceLabel: 'completed:validate',
        issueState: 'CLOSED',
        stateReason: 'COMPLETED',
      }),
    ];
    renderTable(
      groupRows(rows, phasesFor(rows), 'o/r'),
      { tty: true, json: false, colorizer },
    );
    expect(calls.state).toHaveLength(0);
    expect(calls.doneMerged.length).toBeGreaterThan(0);
    expect(calls.doneNotPlanned).toHaveLength(0);
  });

  it('#873: closed + NOT_PLANNED routes through doneNotPlanned, not colorizer.state', () => {
    const { colorizer, calls } = sentinelColorizer();
    const rows = [
      row({
        phase: 'p1',
        state: 'terminal',
        sourceLabel: 'completed:validate',
        issueState: 'CLOSED',
        stateReason: 'NOT_PLANNED',
      }),
    ];
    renderTable(
      groupRows(rows, phasesFor(rows), 'o/r'),
      { tty: true, json: false, colorizer },
    );
    expect(calls.state).toHaveLength(0);
    expect(calls.doneMerged).toHaveLength(0);
    expect(calls.doneNotPlanned.length).toBeGreaterThan(0);
  });

  it('#873: open rows still go through colorizer.state (baseline)', () => {
    const { colorizer, calls } = sentinelColorizer();
    const rows = [
      row({
        phase: 'p1',
        state: 'active',
        issueState: 'OPEN',
        stateReason: null,
      }),
    ];
    renderTable(
      groupRows(rows, phasesFor(rows), 'o/r'),
      { tty: true, json: false, colorizer },
    );
    expect(calls.state).toHaveLength(1);
    expect(calls.doneMerged).toHaveLength(0);
    expect(calls.doneNotPlanned).toHaveLength(0);
  });
});
