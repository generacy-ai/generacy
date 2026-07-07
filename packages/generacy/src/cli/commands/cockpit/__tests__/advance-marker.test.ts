import { describe, it, expect } from 'vitest';
import { formatManualAdvanceComment } from '../manual-advance-marker.js';

describe('formatManualAdvanceComment', () => {
  it('renders the AD-1 marker with an actor', () => {
    const out = formatManualAdvanceComment({
      gate: 'clarification',
      actor: 'octocat',
      ts: '2026-06-26T12:00:00.000Z',
    });
    expect(out).toBe(
      '<!-- generacy-cockpit:manual-advance gate=clarification actor=octocat ts=2026-06-26T12:00:00.000Z -->\n\n' +
        'Manually advanced `waiting-for:clarification` → `completed:clarification` by **@octocat**.',
    );
  });

  it('omits actor= attribute and `by @…` clause when actor is undefined', () => {
    const out = formatManualAdvanceComment({
      gate: 'clarification',
      ts: '2026-06-26T12:00:00.000Z',
    });
    expect(out).toBe(
      '<!-- generacy-cockpit:manual-advance gate=clarification ts=2026-06-26T12:00:00.000Z -->\n\n' +
        'Manually advanced `waiting-for:clarification` → `completed:clarification`.',
    );
    expect(out).not.toContain('actor=');
    expect(out).not.toContain('by **@');
  });

  it("treats actor: '' the same as undefined (omit actor= and `by @…`)", () => {
    const out = formatManualAdvanceComment({
      gate: 'clarification',
      actor: '',
      ts: '2026-06-26T12:00:00.000Z',
    });
    expect(out).toBe(
      '<!-- generacy-cockpit:manual-advance gate=clarification ts=2026-06-26T12:00:00.000Z -->\n\n' +
        'Manually advanced `waiting-for:clarification` → `completed:clarification`.',
    );
  });

  it('rejects invalid gate name (must be /^[a-z][a-z0-9-]*$/)', () => {
    expect(() =>
      formatManualAdvanceComment({ gate: 'Clarification', actor: 'a', ts: '2026-06-26T12:00:00.000Z' }),
    ).toThrow(/invalid gate name/);
    expect(() =>
      formatManualAdvanceComment({ gate: '1foo', actor: 'a', ts: '2026-06-26T12:00:00.000Z' }),
    ).toThrow(/invalid gate name/);
    expect(() =>
      formatManualAdvanceComment({ gate: 'foo bar', actor: 'a', ts: '2026-06-26T12:00:00.000Z' }),
    ).toThrow(/invalid gate name/);
  });

  it('rejects invalid non-empty actor login (must be /^[A-Za-z0-9-]+$/)', () => {
    expect(() =>
      formatManualAdvanceComment({ gate: 'plan-review', actor: 'a/b', ts: '2026-06-26T12:00:00.000Z' }),
    ).toThrow(/invalid actor login/);
    expect(() =>
      formatManualAdvanceComment({
        gate: 'plan-review',
        actor: 'invalid space',
        ts: '2026-06-26T12:00:00.000Z',
      }),
    ).toThrow(/invalid actor login/);
  });

  it('rejects non round-trip ISO-8601 ts', () => {
    expect(() =>
      formatManualAdvanceComment({ gate: 'plan-review', actor: 'a', ts: 'not-a-date' }),
    ).toThrow(/not round-trip ISO-8601/);
    expect(() =>
      formatManualAdvanceComment({ gate: 'plan-review', actor: 'a', ts: '2026-06-26 12:00:00' }),
    ).toThrow(/not round-trip ISO-8601/);
  });
});
