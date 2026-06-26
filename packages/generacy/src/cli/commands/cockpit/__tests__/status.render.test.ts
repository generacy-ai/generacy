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
  it('renders one line per row, prefixed by a group header', () => {
    const groups = groupRows([row({ number: 1 }), row({ number: 2, title: 'Bye' })], {
      kind: 'repos',
      repos: ['o/r'],
    });
    const out = renderTable(groups, { tty: false, json: false, colorizer: identityColorizer });
    const lines = out.split('\n');
    expect(lines[0]).toBe('o/r');
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
      groupRows([row({ title: long })], { kind: 'repos', repos: ['o/r'] }),
      { tty: false, json: false, colorizer: identityColorizer },
    );
    expect(out).toContain('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…');
    expect(out).not.toContain(long);
  });

  it('groups by repo when scope.kind === "repos"', () => {
    const groups = groupRows(
      [row({ repo: 'a/b' }), row({ repo: 'x/y', number: 2 })],
      { kind: 'repos', repos: ['a/b', 'x/y'] },
    );
    const out = renderTable(groups, { tty: false, json: false, colorizer: identityColorizer });
    const lines = out.split('\n');
    expect(lines[0]).toBe('a/b');
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe('x/y');
  });
});

describe('renderJsonEnvelope', () => {
  it('returns a single-line JSON envelope', () => {
    const json = renderJsonEnvelope(
      { kind: 'repos', repos: ['o/r'] },
      [row()],
      { available: true, jobs: 3, workers: 1 },
    );
    expect(json).not.toContain('\n');
    const parsed = JSON.parse(json);
    expect(parsed.scope).toEqual({ kind: 'repos', repos: ['o/r'] });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.orchestrator).toEqual({ available: true, jobs: 3, workers: 1 });
  });

  it('encodes unavailable orchestrator with reason', () => {
    const json = renderJsonEnvelope(
      { kind: 'repos', repos: ['o/r'] },
      [],
      { available: false, reason: 'timeout' },
    );
    const parsed = JSON.parse(json);
    expect(parsed.orchestrator).toEqual({ available: false, reason: 'timeout' });
  });

  it('encodes epic scope when provided', () => {
    const json = renderJsonEnvelope(
      { kind: 'epic', owner: 'o', repo: 'r', ownerRepo: 'o/r', issues: [1, 2] },
      [],
      { available: false, reason: 'no-token' },
      787,
    );
    const parsed = JSON.parse(json);
    expect(parsed.scope).toEqual({ kind: 'epic', owner: 'o', repo: 'r', issue: 787 });
  });
});
