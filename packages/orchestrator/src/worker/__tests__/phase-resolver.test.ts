import { describe, it, expect } from 'vitest';
import { PhaseResolver, GATE_MAPPING, WORKFLOW_GATE_MAPPING } from '../phase-resolver.js';

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
    it('returns "plan" when completed:clarification is present (resumes after clarify gate)', () => {
      expect(
        resolver.resolveStartPhase(
          ['waiting-for:clarification', 'completed:clarification'],
          'continue',
        ),
      ).toBe('plan');
    });

    it('returns "clarify" when completed:spec-review is present (resumes after spec-review gate)', () => {
      expect(
        resolver.resolveStartPhase(
          ['waiting-for:spec-review', 'completed:spec-review'],
          'continue',
        ),
      ).toBe('clarify');
    });

    it('returns "tasks" when completed:plan-review is present (resumes after plan-review gate)', () => {
      expect(
        resolver.resolveStartPhase(
          ['waiting-for:plan-review', 'completed:plan-review'],
          'continue',
        ),
      ).toBe('tasks');
    });

    it('returns "implement" when completed:tasks-review is present (resumes after tasks-review gate)', () => {
      expect(
        resolver.resolveStartPhase(
          ['waiting-for:tasks-review', 'completed:tasks-review'],
          'continue',
        ),
      ).toBe('implement');
    });

    it('returns "validate" when completed:implementation-review is present (resumes after implementation-review gate)', () => {
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

    it('falls back to process resolution when no completed gate labels exist', () => {
      // completed:specify is not a gate name in GATE_MAPPING,
      // so resolveFromContinue falls back to resolveFromProcess
      expect(
        resolver.resolveStartPhase(
          ['waiting-for:clarification', 'completed:specify'],
          'continue',
        ),
      ).toBe('clarify');
    });
  });

  describe('GATE_MAPPING integration', () => {
    it.each([
      ['clarification', 'plan'],
      ['spec-review', 'clarify'],
      ['clarification-review', 'plan'],
      ['plan-review', 'tasks'],
      ['tasks-review', 'implement'],
      ['implementation-review', 'validate'],
    ])('continue with completed:%s resolves to %s', (gateName, expectedPhase) => {
      expect(
        resolver.resolveStartPhase([`completed:${gateName}`], 'continue'),
      ).toBe(expectedPhase);
    });

    it('does not require waiting-for: labels for continue resolution', () => {
      // Only completed: labels, no waiting-for: — should still resolve correctly
      expect(
        resolver.resolveStartPhase(
          ['completed:specify', 'completed:clarification'],
          'continue',
        ),
      ).toBe('plan');
    });

    it('resolveFromProcess normalizes gate names via GATE_MAPPING', () => {
      // completed:clarification should be normalized to clarify phase,
      // so the next phase after specify + clarify is plan
      expect(
        resolver.resolveStartPhase(
          ['completed:specify', 'completed:clarification'],
          'process',
        ),
      ).toBe('plan');
    });

    it('picks the most advanced gate when multiple are completed', () => {
      // spec-review maps to specify phase, plan-review maps to plan phase
      // plan is more advanced, so plan-review's resumeFrom ('tasks') wins
      expect(
        resolver.resolveStartPhase(
          ['completed:spec-review', 'completed:plan-review'],
          'continue',
        ),
      ).toBe('tasks');
    });

    it('GATE_MAPPING contains expected gate entries', () => {
      expect(Object.keys(GATE_MAPPING)).toEqual(
        expect.arrayContaining([
          'clarification',
          'spec-review',
          'clarification-review',
          'plan-review',
          'tasks-review',
          'implementation-review',
          'manual-validation',
        ]),
      );
    });

    it('manual-validation gate resumes from validate', () => {
      expect(
        resolver.resolveStartPhase(
          ['completed:manual-validation'],
          'continue',
        ),
      ).toBe('validate');
    });
  });

  // -------------------------------------------------------------------------
  // Workflow-aware resolution (T006)
  // -------------------------------------------------------------------------
  describe('workflow-aware resolution (speckit-epic)', () => {
    describe('process command with workflowName', () => {
      it('uses epic phase sequence (stops at tasks) when all phases completed', () => {
        // Epic sequence is [specify, clarify, plan, tasks] — when all are completed,
        // terminal phase should be 'tasks' (not 'validate' like the default)
        expect(
          resolver.resolveStartPhase(
            ['completed:specify', 'completed:clarify', 'completed:plan', 'completed:tasks'],
            'process',
            'speckit-epic',
          ),
        ).toBe('tasks');
      });

      it('resolves next uncompleted phase within epic sequence', () => {
        expect(
          resolver.resolveStartPhase(
            ['completed:specify', 'completed:clarify'],
            'process',
            'speckit-epic',
          ),
        ).toBe('plan');
      });

      it('ignores phase:implement label for epic workflow (not in sequence)', () => {
        // 'implement' is not in the epic sequence, so this label should be ignored
        expect(
          resolver.resolveStartPhase(
            ['phase:implement'],
            'process',
            'speckit-epic',
          ),
        ).toBe('specify');
      });

      it('accepts phase:tasks label for epic workflow', () => {
        expect(
          resolver.resolveStartPhase(
            ['phase:tasks'],
            'process',
            'speckit-epic',
          ),
        ).toBe('tasks');
      });
    });

    describe('continue command with workflowName', () => {
      it('resolves tasks-review to tasks (not implement) for speckit-epic', () => {
        // Global GATE_MAPPING: tasks-review → resumeFrom: implement
        // Epic WORKFLOW_GATE_MAPPING: tasks-review → resumeFrom: tasks
        expect(
          resolver.resolveStartPhase(
            ['completed:tasks-review'],
            'continue',
            'speckit-epic',
          ),
        ).toBe('tasks');
      });

      it('resolves children-complete gate for speckit-epic', () => {
        expect(
          resolver.resolveStartPhase(
            ['completed:children-complete'],
            'continue',
            'speckit-epic',
          ),
        ).toBe('tasks');
      });

      it('resolves epic-approval gate for speckit-epic', () => {
        expect(
          resolver.resolveStartPhase(
            ['completed:epic-approval'],
            'continue',
            'speckit-epic',
          ),
        ).toBe('tasks');
      });

      it('still resolves global gates (clarification) for speckit-epic', () => {
        // clarification is not overridden by WORKFLOW_GATE_MAPPING, so global mapping applies
        expect(
          resolver.resolveStartPhase(
            ['completed:clarification'],
            'continue',
            'speckit-epic',
          ),
        ).toBe('plan');
      });
    });

    describe('fallback to global GATE_MAPPING for non-epic workflows', () => {
      it('resolves tasks-review to implement for speckit-feature (global mapping)', () => {
        expect(
          resolver.resolveStartPhase(
            ['completed:tasks-review'],
            'continue',
            'speckit-feature',
          ),
        ).toBe('implement');
      });

      it('resolves tasks-review to implement with no workflowName (global mapping)', () => {
        expect(
          resolver.resolveStartPhase(
            ['completed:tasks-review'],
            'continue',
          ),
        ).toBe('implement');
      });

      it('uses global GATE_MAPPING for unknown workflow names', () => {
        expect(
          resolver.resolveStartPhase(
            ['completed:plan-review'],
            'continue',
            'unknown-workflow',
          ),
        ).toBe('tasks');
      });
    });
  });

  describe('WORKFLOW_GATE_MAPPING', () => {
    it('contains speckit-epic overrides', () => {
      expect(WORKFLOW_GATE_MAPPING).toHaveProperty('speckit-epic');
    });

    it('speckit-epic overrides tasks-review, children-complete, and epic-approval', () => {
      const epicGates = WORKFLOW_GATE_MAPPING['speckit-epic']!;
      expect(Object.keys(epicGates)).toEqual(
        expect.arrayContaining(['tasks-review', 'children-complete', 'epic-approval']),
      );
    });

    it('epic gates all map resumeFrom to tasks', () => {
      const epicGates = WORKFLOW_GATE_MAPPING['speckit-epic']!;
      for (const [, mapping] of Object.entries(epicGates)) {
        expect(mapping.resumeFrom).toBe('tasks');
      }
    });
  });
});
