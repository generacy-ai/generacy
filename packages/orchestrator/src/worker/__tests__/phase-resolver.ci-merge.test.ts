/**
 * Resolver tests for the #1133 CI-aware merge gate flag.
 *
 * Flag ON  → `implementation-review` gate belongs to `validate` and resumes from
 *            `validate` (the terminal phase), so neither `validate` nor
 *            `implement` re-runs on a `continue` carrying the completed gate.
 * Flag OFF → mapping is byte-identical to today (SC-006).
 */
import { describe, it, expect } from 'vitest';
import { PhaseResolver } from '../phase-resolver.js';

const resolver = new PhaseResolver();

describe('PhaseResolver — #1133 ciMergeGateEnabled', () => {
  describe('flag OFF (default) — byte-identical mapping (SC-006)', () => {
    it('continue with completed:implementation-review resumes at validate (today)', () => {
      const phase = resolver.resolveStartPhase(
        ['completed:implementation-review'],
        'continue',
        'speckit-feature',
        false, // reviewPhaseEnabled
        false, // ciMergeGateEnabled
      );
      expect(phase).toBe('validate');
    });

    it('default ciMergeGateEnabled argument (omitted) matches flag OFF', () => {
      const explicit = resolver.resolveStartPhase(
        ['completed:implementation-review'],
        'continue',
        'speckit-feature',
        false,
        false,
      );
      const omitted = resolver.resolveStartPhase(
        ['completed:implementation-review'],
        'continue',
        'speckit-feature',
        false,
      );
      expect(omitted).toBe(explicit);
    });
  });

  describe('flag ON — implementation-review relocated to validate', () => {
    it('continue with completed:implementation-review resumes at validate (terminal no-op)', () => {
      const phase = resolver.resolveStartPhase(
        ['completed:implementation-review'],
        'continue',
        'speckit-feature',
        false,
        true, // ciMergeGateEnabled
      );
      // validate is the terminal phase; re-entering there short-circuits to
      // complete in executeLoopInner rather than re-running implement.
      expect(phase).toBe('validate');
    });

    it('does not resume at implement when the gate is satisfied', () => {
      const phase = resolver.resolveStartPhase(
        ['completed:implementation-review'],
        'continue',
        'speckit-feature',
        false,
        true,
      );
      expect(phase).not.toBe('implement');
    });

    it('process: completed:implementation-review normalizes to validate, not implement', () => {
      // Flag ON: the gate name maps to phase `validate`, so a process requeue
      // with everything through implement done resolves the terminal phase.
      const labels = [
        'completed:specify',
        'completed:clarify',
        'completed:plan',
        'completed:tasks',
        'completed:implement',
        'completed:implementation-review',
      ];
      const on = resolver.resolveStartPhase(labels, 'process', 'speckit-feature', false, true);
      const off = resolver.resolveStartPhase(labels, 'process', 'speckit-feature', false, false);
      // Both land on the terminal `validate`, but ON reaches it because the gate
      // marks validate complete, OFF because validate is the first uncompleted.
      expect(on).toBe('validate');
      expect(off).toBe('validate');
    });
  });
});
