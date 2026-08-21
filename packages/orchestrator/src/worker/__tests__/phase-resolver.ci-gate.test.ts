/**
 * #1154 FR-004 / SC-005: the `ci` gate resolves via the normal `GATE_MAPPING`
 * path (not the `resolveFromProcess` fallback) and `ci` is a member of the
 * derived human-gate suffix set — so `completed:ci` survives the resume strip
 * in `LabelManager.onResumeStart()`.
 *
 * `HUMAN_GATE_SUFFIXES` is module-private in `label-manager.ts`; its public
 * surface is `isHumanGateCompletion()`, which is what the resume strip consults,
 * so membership is asserted through that predicate.
 */
import { describe, it, expect } from 'vitest';
import { PhaseResolver } from '../phase-resolver.js';
import { isHumanGateCompletion } from '../label-manager.js';

const resolver = new PhaseResolver();

describe('PhaseResolver — #1154 ci gate mapping', () => {
  it('continue with completed:ci resolves to validate via the normal mapping', () => {
    const phase = resolver.resolveStartPhase(
      ['completed:ci'],
      'continue',
      'speckit-feature',
      false, // reviewPhaseEnabled
      true, // ciMergeGateEnabled
    );
    expect(phase).toBe('validate');
  });

  it('resolves via GATE_MAPPING, not the resolveFromProcess fallback', () => {
    // If `ci` had no GATE_MAPPING entry, resolveFromContinue would find no
    // matching gate and fall through to resolveFromProcess, which — given a
    // single non-phase, non-gate `completed:ci` label — resolves the first
    // uncompleted phase (`specify`). Landing on `validate` proves the gate path.
    const phase = resolver.resolveStartPhase(['completed:ci'], 'continue', 'speckit-feature');
    expect(phase).toBe('validate');
    expect(phase).not.toBe('specify');
  });

  it('ci is a human-gate suffix (completed:ci survives the resume strip)', () => {
    expect(isHumanGateCompletion('completed:ci')).toBe(true);
  });
});
