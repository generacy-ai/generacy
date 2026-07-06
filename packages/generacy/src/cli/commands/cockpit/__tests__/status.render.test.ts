import { describe, expect, it } from 'vitest';
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
    ...overrides,
  };
}

describe('renderTable (plain non-TTY path)', () => {
  it('renders one line per row prefixed by the epic group header', () => {
    const groups = groupRows(
      [row({ number: 1 }), row({ number: 2, title: 'Bye' })],
      'o/r',
    );
    const out = renderTable(groups, { tty: false, json: false, colorizer: identityColorizer });
    const lines = out.split('\n');
    expect(lines[0]).toBe('epic o/r');
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
    const out = renderTable(
      groupRows([row({ title: long })], 'o/r'),
      { tty: false, json: false, colorizer: identityColorizer },
    );
    expect(out).toContain('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…');
    expect(out).not.toContain(long);
  });

  it('epic mode flattens rows under a single header sorted by number', () => {
    const groups = groupRows(
      [row({ repo: 'a/b', number: 2 }), row({ repo: 'x/y', number: 1 })],
      'o/epic',
    );
    const out = renderTable(groups, { tty: false, json: false, colorizer: identityColorizer });
    const lines = out.split('\n');
    expect(lines[0]).toBe('epic o/epic');
    // Number 1 (x/y) sorts before number 2 (a/b) under epic grouping.
    expect(lines[1]).toContain('#    1');
    expect(lines[2]).toContain('#    2');
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
});
