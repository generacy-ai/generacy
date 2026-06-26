import { describe, it, expect } from 'vitest';
import { GATES, listGates } from '../gate-vocabulary.js';

describe('gate-vocabulary', () => {
  it('derives each gate with matching waiting-for / completed labels', () => {
    for (const def of GATES.values()) {
      expect(def.waitingLabel).toBe(`waiting-for:${def.name}`);
      expect(def.completedLabel).toBe(`completed:${def.name}`);
    }
  });

  it('includes the pairs that have both waiting-for:* and completed:* in WORKFLOW_LABELS', () => {
    // Cross-referenced against packages/workflow-engine/src/actions/github/label-definitions.ts.
    // Pairs where only the waiting-for or only the completed side exists are excluded.
    const expected = [
      'clarification',
      'clarification-review',
      'spec-review',
      'plan-review',
      'tasks-review',
      'implementation-review',
      'manual-validation',
      'children-complete',
      'epic-approval',
    ];
    for (const name of expected) {
      expect(GATES.has(name), `expected gate ${name} in GATES`).toBe(true);
    }
  });

  it('excludes waiting-for:* labels that have no completed:* partner', () => {
    // These exist as waiting-for:* but lack a completed:* in WORKFLOW_LABELS — not gates.
    expect(GATES.has('sibling-review')).toBe(false);
    expect(GATES.has('pr-feedback')).toBe(false);
    expect(GATES.has('address-pr-feedback')).toBe(false);
    expect(GATES.has('dependencies')).toBe(false);
  });

  it('excludes unpaired completed-only labels (phase completions)', () => {
    expect(GATES.has('setup')).toBe(false);
    expect(GATES.has('specify')).toBe(false);
    expect(GATES.has('clarify')).toBe(false);
    expect(GATES.has('plan')).toBe(false);
    expect(GATES.has('tasks')).toBe(false);
    expect(GATES.has('implement')).toBe(false);
    expect(GATES.has('validate')).toBe(false);
  });

  it('listGates() returns the same order as GATES.keys()', () => {
    expect(listGates()).toEqual(Array.from(GATES.keys()));
  });
});
