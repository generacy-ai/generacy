import { describe, expect, it } from 'vitest';
import type { CockpitState } from '@generacy-ai/cockpit';
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
    ...overrides,
  };
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
    const out = renderTable(
      groupRows([row()], { kind: 'repos', repos: ['o/r'] }),
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
      row({ number: 1, state: 'terminal' }),
      row({ number: 2, state: 'error' }),
      row({ number: 3, state: 'waiting' }),
      row({ number: 4, state: 'pending' }),
      row({ number: 5, state: 'unknown' }),
    ];
    renderTable(
      groupRows(rows, { kind: 'repos', repos: ['o/r'] }),
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
