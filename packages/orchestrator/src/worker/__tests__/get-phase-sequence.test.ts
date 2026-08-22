import { describe, it, expect } from 'vitest';
import { getPhaseSequence } from '../types.js';

// #1165 Corner 4 (FR-007 / FR-008) — the getPhaseSequence fallback for unknown
// workflows must never include `review`. An unknown workflow has no gate map
// (gate-checker returns []), so an `on-remediation-limit` gate can never be
// applied and a review→remediate loop would be uncapped. Dropping `review` from
// the fallback removes that precondition. Known workflows keep the existing
// flag-conditional behavior (FR-009 byte-identical guard).
//
// See `contracts/get-phase-sequence.md` and `data-model.md` E1 truth table.
describe('getPhaseSequence — #1165 Corner 4 truth table', () => {
  it('unknown workflow + flag ON ⇒ excludes review (the row that changes)', () => {
    const seq = getPhaseSequence('unknown-workflow', true);
    expect(seq).not.toContain('review');
    expect(seq).not.toContain('remediate');
  });

  it('unknown workflow + flag OFF ⇒ excludes review', () => {
    const seq = getPhaseSequence('unknown-workflow', false);
    expect(seq).not.toContain('review');
    expect(seq).not.toContain('remediate');
  });

  it('speckit-feature + flag ON ⇒ includes review (regression guard)', () => {
    expect(getPhaseSequence('speckit-feature', true)).toContain('review');
  });

  it('speckit-feature + flag OFF ⇒ excludes review (regression guard)', () => {
    expect(getPhaseSequence('speckit-feature', false)).not.toContain('review');
  });

  it('speckit-epic never includes review (any flag)', () => {
    expect(getPhaseSequence('speckit-epic', true)).not.toContain('review');
    expect(getPhaseSequence('speckit-epic', false)).not.toContain('review');
  });

  it('is pure — repeated calls return equal, independent arrays', () => {
    const a = getPhaseSequence('unknown-workflow', true);
    const b = getPhaseSequence('unknown-workflow', true);
    expect(a).toEqual(b);
    a.push('review');
    expect(getPhaseSequence('unknown-workflow', true)).not.toContain('review');
  });
});
