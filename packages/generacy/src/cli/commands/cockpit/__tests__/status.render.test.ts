import { describe, expect, it } from 'vitest';
import type { ParsedPhase } from '@generacy-ai/cockpit';
import {
  renderTable,
  renderJsonEnvelope,
} from '../status/render-table.js';
import { identityColorizer } from '../status/color.js';
import type { StatusRow } from '../status/row.js';
import { groupRows } from '../status/group.js';

function row(overrides: Partial<StatusRow> = {}): StatusRow {
  return {
    repo: 'o/r',
    kind: 'issue',
    number: 1,
    title: 'Hello',
    state: 'active',
    sourceLabel: 'phase:plan',
    prNumber: null,
    checks: 'none',
    url: 'https://github.com/o/r/issues/1',
    phase: null,
    ...overrides,
  };
}

function phase(overrides: Partial<ParsedPhase> & Pick<ParsedPhase, 'token'>): ParsedPhase {
  return {
    heading: overrides.heading ?? overrides.token,
    token: overrides.token,
    refs: overrides.refs ?? [],
  };
}

describe('renderTable (plain non-TTY path)', () => {
  it('renders rows under a phase-headed group', () => {
    const phases: ParsedPhase[] = [
      phase({
        heading: 'P1 — Foundation',
        token: 'p1',
        refs: [
          { repo: 'o/r', number: 1 },
          { repo: 'o/r', number: 2 },
        ],
      }),
    ];
    const groups = groupRows(
      [row({ number: 1, phase: 'p1' }), row({ number: 2, title: 'Bye', phase: 'p1' })],
      phases,
      'o/r',
    );
    const out = renderTable(groups, { tty: false, json: false, colorizer: identityColorizer });
    const lines = out.split('\n');
    expect(lines[0]).toBe('— P1 — Foundation —');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('#    1');
    expect(lines[1]).toContain('active');
    expect(lines[1]).toContain('phase:plan');
    expect(lines[1]).toContain('PR     -');
    expect(lines[1]).toContain('none');
    expect(lines[1]).toContain('Hello');
  });

  it('truncates long titles with `…`', () => {
    const long = 'x'.repeat(80);
    const phases: ParsedPhase[] = [
      phase({ heading: 'P1', token: 'p1', refs: [{ repo: 'o/r', number: 1 }] }),
    ];
    const out = renderTable(
      groupRows([row({ title: long, phase: 'p1' })], phases, 'o/r'),
      { tty: false, json: false, colorizer: identityColorizer },
    );
    expect(out).toContain('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…');
    expect(out).not.toContain(long);
  });

  it('emits one group per phase in body order; rows within each group in ParsedPhase.refs order', () => {
    const phases: ParsedPhase[] = [
      phase({
        heading: 'P1 — Foundation',
        token: 'p1',
        refs: [
          { repo: 'a/b', number: 5 },
          { repo: 'a/b', number: 3 },
        ],
      }),
      phase({
        heading: 'P2 — Ship',
        token: 'p2',
        refs: [
          { repo: 'x/y', number: 10 },
        ],
      }),
    ];
    const groups = groupRows(
      [
        row({ repo: 'a/b', number: 3, phase: 'p1' }),
        row({ repo: 'a/b', number: 5, phase: 'p1' }),
        row({ repo: 'x/y', number: 10, phase: 'p2' }),
      ],
      phases,
      'o/epic',
    );
    const out = renderTable(groups, { tty: false, json: false, colorizer: identityColorizer });
    const lines = out.split('\n');
    expect(lines[0]).toBe('— P1 — Foundation —');
    expect(lines[1]).toContain('#    5');
    expect(lines[2]).toContain('#    3');
    // blank separator line, then next group header
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe('— P2 — Ship —');
    expect(lines[5]).toContain('#   10');
  });

  it("header uses full 'heading' when heading !== token; falls back to '— <TOKEN-UPPER> —' when label-less", () => {
    const phases: ParsedPhase[] = [
      phase({ heading: 'P1 — Foundation', token: 'p1', refs: [{ repo: 'o/r', number: 1 }] }),
      phase({ heading: 'P2', token: 'p2', refs: [{ repo: 'o/r', number: 2 }] }),
    ];
    const groups = groupRows(
      [row({ number: 1, phase: 'p1' }), row({ number: 2, phase: 'p2' })],
      phases,
      'o/r',
    );
    expect(groups[0]!.header).toBe('— P1 — Foundation —');
    expect(groups[1]!.header).toBe('— P2 —');
  });

  it("trailing '— (no phase) —' group appears when any StatusRow.phase is null", () => {
    const phases: ParsedPhase[] = [
      phase({ heading: 'P1', token: 'p1', refs: [{ repo: 'o/r', number: 1 }] }),
    ];
    const groups = groupRows(
      [row({ number: 1, phase: 'p1' }), row({ number: 99, phase: null })],
      phases,
      'o/r',
    );
    expect(groups).toHaveLength(2);
    expect(groups[1]!.header).toBe('— (no phase) —');
    expect(groups[1]!.rows).toHaveLength(1);
    expect(groups[1]!.rows[0]!.number).toBe(99);
  });

  it("phase-less epic (phases.length === 0) renders a single '— (no phase) —' group", () => {
    const groups = groupRows(
      [row({ number: 1, phase: null }), row({ number: 2, phase: null })],
      [],
      'o/r',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.header).toBe('— (no phase) —');
    expect(groups[0]!.rows).toHaveLength(2);
  });

  it('cross-phase duplicate ref renders once per phase group and once per membership in JSON', () => {
    const phases: ParsedPhase[] = [
      phase({
        heading: 'P1',
        token: 'p1',
        refs: [{ repo: 'o/r', number: 7 }],
      }),
      phase({
        heading: 'P2',
        token: 'p2',
        refs: [{ repo: 'o/r', number: 7 }],
      }),
    ];
    const groups = groupRows(
      [row({ number: 7, phase: 'p1' }), row({ number: 7, phase: 'p2' })],
      phases,
      'o/r',
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]!.rows).toHaveLength(1);
    expect(groups[0]!.rows[0]!.number).toBe(7);
    expect(groups[0]!.rows[0]!.phase).toBe('p1');
    expect(groups[1]!.rows).toHaveLength(1);
    expect(groups[1]!.rows[0]!.number).toBe(7);
    expect(groups[1]!.rows[0]!.phase).toBe('p2');

    const flat = groups.flatMap((g) => g.rows);
    const envelope = JSON.parse(
      renderJsonEnvelope({ owner: 'o', repo: 'r', issue: 1 }, flat),
    );
    expect(envelope.rows).toHaveLength(2);
    expect(envelope.rows[0].phase).toBe('p1');
    expect(envelope.rows[1].phase).toBe('p2');
  });
});

describe('renderJsonEnvelope', () => {
  it('returns a single-line JSON envelope with epic scope', () => {
    const json = renderJsonEnvelope(
      { owner: 'o', repo: 'r', issue: 42 },
      [row()],
    );
    expect(json).not.toContain('\n');
    const parsed = JSON.parse(json);
    expect(parsed.scope).toEqual({ kind: 'epic', owner: 'o', repo: 'r', issue: 42 });
    expect(parsed.rows).toHaveLength(1);
  });

  it("every row has 'phase' as string | null", () => {
    const phases: ParsedPhase[] = [
      phase({
        heading: 'P1 — Foundation',
        token: 'p1',
        refs: [
          { repo: 'o/r', number: 1 },
          { repo: 'o/r', number: 2 },
        ],
      }),
      phase({ heading: 'P2', token: 'p2', refs: [{ repo: 'o/r', number: 3 }] }),
    ];
    const groups = groupRows(
      [
        row({ number: 1, phase: 'p1' }),
        row({ number: 2, phase: 'p1' }),
        row({ number: 3, phase: 'p2' }),
        row({ number: 99, phase: null }),
      ],
      phases,
      'o/r',
    );
    const flat = groups.flatMap((g) => g.rows);
    const parsed = JSON.parse(
      renderJsonEnvelope({ owner: 'o', repo: 'r', issue: 1 }, flat),
    );
    expect(parsed.rows).toHaveLength(4);
    for (const r of parsed.rows) {
      expect(Object.prototype.hasOwnProperty.call(r, 'phase')).toBe(true);
      expect(r.phase === null || typeof r.phase === 'string').toBe(true);
    }
    // Order: p1 refs body order (1, 2), then p2 (3), then null last.
    expect(parsed.rows.map((r: { phase: string | null }) => r.phase)).toEqual([
      'p1',
      'p1',
      'p2',
      null,
    ]);
  });
});
