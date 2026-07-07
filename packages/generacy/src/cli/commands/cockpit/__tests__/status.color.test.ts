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

function sentinelColorizer(): {
  colorizer: Colorizer;
  calls: Array<{ s: string; state: CockpitState }>;
} {
  const calls: Array<{ s: string; state: CockpitState }> = [];
  return {
    colorizer: {
      state(s, state) {
        calls.push({ s, state });
        return `<${state}>${s}</${state}>`;
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
    expect(calls).toHaveLength(1);
    expect(calls[0]?.state).toBe('active');
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
    expect(calls.map((c) => c.state)).toEqual([
      'terminal',
      'error',
      'waiting',
      'pending',
      'unknown',
    ]);
  });
});
