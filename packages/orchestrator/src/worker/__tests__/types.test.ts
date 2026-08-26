import { describe, it, expect } from 'vitest';
import {
  PHASE_SEQUENCE,
  WORKFLOW_PHASE_SEQUENCES,
  PHASE_TO_STAGE,
  getPhaseSequence,
} from '../types.js';
import type { WorkflowPhase } from '../types.js';
import { PauseContextSchema } from '../pause-context.js';
import { GateDefinitionSchema } from '../config.js';

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

  it('always excludes review for unknown workflow names, regardless of flag (#1165 Corner 4)', () => {
    // Unknown workflows have no gate map, so an on-remediation-limit gate can
    // never cap a review→remediate loop. review must never enter the fallback
    // sequence — for either flag value (FR-007).
    expect(getPhaseSequence('unknown-workflow')).toEqual(FLAG_OFF_SEQUENCE);
    expect(getPhaseSequence('')).toEqual(FLAG_OFF_SEQUENCE);
    expect(getPhaseSequence('custom-workflow')).toEqual(FLAG_OFF_SEQUENCE);
    expect(getPhaseSequence('unknown-workflow', true)).toEqual(FLAG_OFF_SEQUENCE);
    expect(getPhaseSequence('unknown-workflow', true)).not.toContain('review');
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

// ---------------------------------------------------------------------------
// US3 (#1123) — phase-union sync audit (FR-006, SC-005).
//
// A TS union has no runtime members, so the source-of-truth keyset is the
// `PHASE_TO_STAGE` keyset (total over `WorkflowPhase` by construction — it is
// typed `Record<WorkflowPhase, StageType>`, so `tsc` fails if a phase is
// missing). Every hand-maintained runtime duplicate that `tsc` does NOT enforce
// (the two z.enum companions) must set-equal that keyset. `remediate` is
// off-sequence, so it lives in the keyset but NOT in the linear PHASE_SEQUENCE —
// the linear-sequence assertions exclude it via the keyset, not the sequence.
//
// This complements (does not duplicate) `phase-vocabulary-audit.test.ts`, which
// asserts PRESENCE of review/remediate at each site. Here we assert strict
// set-EQUALITY of the companion z.enum options against the keyset, both
// directions — so adding OR dropping a phase in one companion turns this red.
// ---------------------------------------------------------------------------
describe('phase-union sync audit (#1123 US3)', () => {
  // Runtime source-of-truth keyset (T015).
  const PHASE_KEYSET = Object.keys(PHASE_TO_STAGE) as WorkflowPhase[];

  it('keyset contains both new phases (review linear, remediate off-sequence)', () => {
    expect(PHASE_KEYSET).toContain('review');
    expect(PHASE_KEYSET).toContain('remediate');
  });

  // T016 — every linear-sequence member is a phase in the keyset, and every
  // keyset phase EXCEPT the off-sequence `remediate` appears in PHASE_SEQUENCE.
  it('PHASE_SEQUENCE members are all keyset phases', () => {
    for (const phase of PHASE_SEQUENCE) {
      expect(PHASE_KEYSET).toContain(phase);
    }
  });

  it('every keyset phase except off-sequence remediate is in PHASE_SEQUENCE', () => {
    const expectedInSequence = PHASE_KEYSET.filter((p) => p !== 'remediate');
    expect([...PHASE_SEQUENCE].sort()).toEqual([...expectedInSequence].sort());
    // Guard the off-sequence invariant explicitly.
    expect(PHASE_SEQUENCE).not.toContain('remediate');
  });

  it('the shared feature/bugfix sequences draw only from keyset phases', () => {
    for (const name of ['speckit-feature', 'speckit-bugfix']) {
      for (const phase of getPhaseSequence(name, true)) {
        expect(PHASE_KEYSET).toContain(phase);
      }
    }
  });

  it('every phase is a key in PHASE_TO_STAGE (belt-and-suspenders alongside tsc)', () => {
    for (const phase of PHASE_KEYSET) {
      expect(PHASE_TO_STAGE[phase]).toBeDefined();
    }
  });

  // T017 — the two hand-maintained runtime z.enum duplicates set-equal the keyset.
  it('pause-context WorkflowPhaseSchema options set-equal the keyset', () => {
    const options = PauseContextSchema.shape.phase.options as readonly string[];
    expect([...options].sort()).toEqual([...PHASE_KEYSET].sort());
  });

  it('config GateDefinitionSchema.phase options set-equal the keyset', () => {
    const options = GateDefinitionSchema.shape.phase.options as readonly string[];
    expect([...options].sort()).toEqual([...PHASE_KEYSET].sort());
  });
});
