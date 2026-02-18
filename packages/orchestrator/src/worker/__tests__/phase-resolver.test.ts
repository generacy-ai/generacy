import { describe, it, expect } from 'vitest';
import { PhaseResolver } from '../phase-resolver.js';

describe('PhaseResolver', () => {
  const resolver = new PhaseResolver();

  describe('process command', () => {
    it('returns "specify" when there are no labels', () => {
      expect(resolver.resolveStartPhase([], 'process')).toBe('specify');
    });

    it('returns "clarify" when completed:specify is present', () => {
      expect(
        resolver.resolveStartPhase(['completed:specify'], 'process'),
      ).toBe('clarify');
    });

    it('returns "plan" when completed:specify and completed:clarify are present', () => {
      expect(
        resolver.resolveStartPhase(
          ['completed:specify', 'completed:clarify'],
          'process',
        ),
      ).toBe('plan');
    });

    it('returns "plan" when an active phase:plan label is present', () => {
      expect(
        resolver.resolveStartPhase(['phase:plan'], 'process'),
      ).toBe('plan');
    });

    it('returns "validate" when all phases are completed', () => {
      expect(
        resolver.resolveStartPhase(
          [
            'completed:specify',
            'completed:clarify',
            'completed:plan',
            'completed:tasks',
            'completed:implement',
            'completed:validate',
          ],
          'process',
        ),
      ).toBe('validate');
    });

    it('ignores invalid phase: labels not in PHASE_SEQUENCE', () => {
      // An invalid phase label like "phase:nonexistent" should be ignored,
      // falling through to completed-label or default logic
      expect(
        resolver.resolveStartPhase(['phase:nonexistent'], 'process'),
      ).toBe('specify');
    });
  });

  describe('continue command', () => {
    it('returns "clarify" when waiting-for:clarification and completed:clarification are present', () => {
      expect(
        resolver.resolveStartPhase(
          ['waiting-for:clarification', 'completed:clarification'],
          'continue',
        ),
      ).toBe('clarify');
    });

    it('returns "clarify" when waiting-for:spec-review and completed:spec-review are present', () => {
      expect(
        resolver.resolveStartPhase(
          ['waiting-for:spec-review', 'completed:spec-review'],
          'continue',
        ),
      ).toBe('clarify');
    });

    it('returns "tasks" when waiting-for:plan-review and completed:plan-review are present', () => {
      expect(
        resolver.resolveStartPhase(
          ['waiting-for:plan-review', 'completed:plan-review'],
          'continue',
        ),
      ).toBe('tasks');
    });

    it('returns "implement" when waiting-for:tasks-review and completed:tasks-review are present', () => {
      expect(
        resolver.resolveStartPhase(
          ['waiting-for:tasks-review', 'completed:tasks-review'],
          'continue',
        ),
      ).toBe('implement');
    });

    it('returns "validate" when waiting-for:implementation-review and completed:implementation-review are present', () => {
      expect(
        resolver.resolveStartPhase(
          [
            'waiting-for:implementation-review',
            'completed:implementation-review',
          ],
          'continue',
        ),
      ).toBe('validate');
    });

    it('falls back to process resolution when no matching waiting-for/completed pair exists', () => {
      // Only a waiting-for label without a matching completed label
      // should fall back to resolveFromProcess logic
      expect(
        resolver.resolveStartPhase(
          ['waiting-for:clarification', 'completed:specify'],
          'continue',
        ),
      ).toBe('clarify');
    });
  });
});
