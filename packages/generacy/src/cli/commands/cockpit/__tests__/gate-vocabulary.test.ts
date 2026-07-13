import { describe, it, expect } from 'vitest';
import { GATES, listGates, resolvePrecedingGate } from '../gate-vocabulary.js';

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

describe('resolvePrecedingGate truth table (#891)', () => {
  // Truth-table from specs/891-found-during-cockpit-v1/contracts/gate-vocabulary-api.md.
  // Any GATE_MAPPING upstream change that flips a row causes deterministic failure.

  it('failed:validate → implementation-review (cross-phase wins over manual-validation self-loop)', () => {
    const result = resolvePrecedingGate('validate');
    expect(result).toEqual({
      kind: 'found',
      gate: {
        name: 'implementation-review',
        waitingLabel: 'waiting-for:implementation-review',
        completedLabel: 'completed:implementation-review',
        sourcePhase: 'implement',
        isSelfLoop: false,
      },
    });
  });

  it('failed:implement → tasks-review (single cross-phase candidate)', () => {
    const result = resolvePrecedingGate('implement');
    expect(result).toEqual({
      kind: 'found',
      gate: {
        name: 'tasks-review',
        waitingLabel: 'waiting-for:tasks-review',
        completedLabel: 'completed:tasks-review',
        sourcePhase: 'tasks',
        isSelfLoop: false,
      },
    });
  });

  it('failed:tasks → plan-review (single cross-phase candidate)', () => {
    const result = resolvePrecedingGate('tasks');
    expect(result).toEqual({
      kind: 'found',
      gate: {
        name: 'plan-review',
        waitingLabel: 'waiting-for:plan-review',
        completedLabel: 'completed:plan-review',
        sourcePhase: 'plan',
        isSelfLoop: false,
      },
    });
  });

  it('failed:plan → no-preceding-gate (evidence points at process:* re-queue)', () => {
    const result = resolvePrecedingGate('plan');
    expect(result).toEqual({ kind: 'no-preceding-gate', targetPhase: 'plan' });
  });

  it('failed:clarify → spec-review (cross-phase wins over clarification/clarification-review self-loops)', () => {
    const result = resolvePrecedingGate('clarify');
    expect(result).toEqual({
      kind: 'found',
      gate: {
        name: 'spec-review',
        waitingLabel: 'waiting-for:spec-review',
        completedLabel: 'completed:spec-review',
        sourcePhase: 'specify',
        isSelfLoop: false,
      },
    });
  });

  it('failed:specify → no-preceding-gate (evidence points at process:* re-queue)', () => {
    const result = resolvePrecedingGate('specify');
    expect(result).toEqual({ kind: 'no-preceding-gate', targetPhase: 'specify' });
  });

  it('speckit-epic overlay: failed:tasks still resolves to plan-review (cross-phase wins over epic self-loops)', () => {
    const result = resolvePrecedingGate('tasks', 'speckit-epic');
    expect(result).toEqual({
      kind: 'found',
      gate: {
        name: 'plan-review',
        waitingLabel: 'waiting-for:plan-review',
        completedLabel: 'completed:plan-review',
        sourcePhase: 'plan',
        isSelfLoop: false,
      },
    });
  });

  it('unknown workflow name falls back to base GATE_MAPPING', () => {
    const result = resolvePrecedingGate('validate', 'no-such-workflow');
    expect(result).toEqual({
      kind: 'found',
      gate: {
        name: 'implementation-review',
        waitingLabel: 'waiting-for:implementation-review',
        completedLabel: 'completed:implementation-review',
        sourcePhase: 'implement',
        isSelfLoop: false,
      },
    });
  });
});
