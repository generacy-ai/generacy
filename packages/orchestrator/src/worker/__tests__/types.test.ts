import { describe, it, expect } from 'vitest';
import {
  PHASE_SEQUENCE,
  WORKFLOW_PHASE_SEQUENCES,
  getPhaseSequence,
} from '../types.js';

describe('getPhaseSequence', () => {
  it('returns full PHASE_SEQUENCE for speckit-feature', () => {
    expect(getPhaseSequence('speckit-feature')).toEqual(PHASE_SEQUENCE);
  });

  it('returns full PHASE_SEQUENCE for speckit-bugfix', () => {
    expect(getPhaseSequence('speckit-bugfix')).toEqual(PHASE_SEQUENCE);
  });

  it('returns truncated sequence for speckit-epic (no implement/validate)', () => {
    expect(getPhaseSequence('speckit-epic')).toEqual([
      'specify', 'clarify', 'plan', 'tasks',
    ]);
  });

  it('falls back to PHASE_SEQUENCE for unknown workflow names', () => {
    expect(getPhaseSequence('unknown-workflow')).toEqual(PHASE_SEQUENCE);
    expect(getPhaseSequence('')).toEqual(PHASE_SEQUENCE);
    expect(getPhaseSequence('custom-workflow')).toEqual(PHASE_SEQUENCE);
  });

  it('returns a reference to WORKFLOW_PHASE_SEQUENCES entries when they exist', () => {
    // Verify that known workflows resolve to their registered sequence
    for (const [name, sequence] of Object.entries(WORKFLOW_PHASE_SEQUENCES)) {
      expect(getPhaseSequence(name)).toBe(sequence);
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
