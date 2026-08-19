import { describe, it, expect } from 'vitest';
import {
  PHASE_SEQUENCE,
  WORKFLOW_PHASE_SEQUENCES,
  getPhaseSequence,
} from '../types.js';

// #1121: the flag-OFF (default) sequence is PHASE_SEQUENCE with `review` gated
// out — the pre-change 6-phase sequence. The flag-ON sequence is the full
// canonical superset.
const FLAG_OFF_SEQUENCE = ['specify', 'clarify', 'plan', 'tasks', 'implement', 'validate'];

describe('getPhaseSequence', () => {
  it('excludes review for speckit-feature when the flag is off (default)', () => {
    expect(getPhaseSequence('speckit-feature')).toEqual(FLAG_OFF_SEQUENCE);
    expect(getPhaseSequence('speckit-feature')).not.toContain('review');
  });

  it('excludes review for speckit-bugfix when the flag is off (default)', () => {
    expect(getPhaseSequence('speckit-bugfix')).toEqual(FLAG_OFF_SEQUENCE);
    expect(getPhaseSequence('speckit-bugfix')).not.toContain('review');
  });

  it('includes review (full PHASE_SEQUENCE) when reviewPhaseEnabled is true', () => {
    expect(getPhaseSequence('speckit-feature', true)).toEqual(PHASE_SEQUENCE);
    expect(getPhaseSequence('speckit-bugfix', true)).toEqual(PHASE_SEQUENCE);
    expect(getPhaseSequence('speckit-feature', true)).toContain('review');
  });

  it('returns truncated sequence for speckit-epic (no implement/validate) regardless of flag', () => {
    const epic = ['specify', 'clarify', 'plan', 'tasks'];
    expect(getPhaseSequence('speckit-epic')).toEqual(epic);
    expect(getPhaseSequence('speckit-epic', true)).toEqual(epic);
  });

  it('falls back to the flag-gated PHASE_SEQUENCE for unknown workflow names', () => {
    expect(getPhaseSequence('unknown-workflow')).toEqual(FLAG_OFF_SEQUENCE);
    expect(getPhaseSequence('')).toEqual(FLAG_OFF_SEQUENCE);
    expect(getPhaseSequence('custom-workflow')).toEqual(FLAG_OFF_SEQUENCE);
    expect(getPhaseSequence('unknown-workflow', true)).toEqual(PHASE_SEQUENCE);
  });

  it('returns the registered sequence by reference when the flag keeps review', () => {
    // With the flag ON there is no filtering, so known workflows resolve to
    // their registered array by reference (no defensive copy).
    for (const [name, sequence] of Object.entries(WORKFLOW_PHASE_SEQUENCES)) {
      expect(getPhaseSequence(name, true)).toBe(sequence);
    }
  });
});

describe('WORKFLOW_PHASE_SEQUENCES', () => {
  it('contains entries for speckit-feature, speckit-bugfix, and speckit-epic', () => {
    expect(Object.keys(WORKFLOW_PHASE_SEQUENCES)).toEqual(
      expect.arrayContaining(['speckit-feature', 'speckit-bugfix', 'speckit-epic']),
    );
  });

  it('speckit-epic sequence ends at tasks (no implement or validate)', () => {
    const epicSequence = WORKFLOW_PHASE_SEQUENCES['speckit-epic']!;
    expect(epicSequence).not.toContain('implement');
    expect(epicSequence).not.toContain('validate');
    expect(epicSequence[epicSequence.length - 1]).toBe('tasks');
  });

  it('speckit-feature and speckit-bugfix share the same default sequence', () => {
    expect(WORKFLOW_PHASE_SEQUENCES['speckit-feature']).toBe(
      WORKFLOW_PHASE_SEQUENCES['speckit-bugfix'],
    );
  });
});
