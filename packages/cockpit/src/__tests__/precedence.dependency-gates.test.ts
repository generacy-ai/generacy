/**
 * #1211 T018 — SC-004: the dependency-block gates are first-class cockpit
 * waiting gates.
 *
 * Pins:
 *   - both `waiting-for:dependencies` and `waiting-for:dependency-limit` are in
 *     `WAITING_PIPELINE_ORDER` (exactly once each — a duplicated entry is dead
 *     weight that silently shadows the real one);
 *   - `waiting-for:dependency-limit` sits beside `waiting-for:remediation-limit`
 *     and outranks `waiting-for:dependencies` (the cap pause is the more
 *     specific, operator-actionable state);
 *   - both classify into the `waiting` tier;
 *   - the gate-vocabulary precondition holds — each `waiting-for:<name>` has a
 *     `completed:<name>` partner in `WORKFLOW_LABELS`, which is what makes
 *     `cockpit advance --gate dependencies|dependency-limit` derivable with no
 *     cockpit-CLI code change.
 */
import { describe, expect, it } from 'vitest';
import { WORKFLOW_LABELS } from '@generacy-ai/workflow-engine';
import { classify } from '../state/classifier.js';
import { WAITING_PIPELINE_ORDER } from '../state/precedence.js';

const DEPENDENCIES = 'waiting-for:dependencies';
const DEPENDENCY_LIMIT = 'waiting-for:dependency-limit';

describe('#1211 dependency gates in cockpit precedence', () => {
  it('SC-004: both gates appear in WAITING_PIPELINE_ORDER exactly once', () => {
    for (const label of [DEPENDENCIES, DEPENDENCY_LIMIT]) {
      const occurrences = WAITING_PIPELINE_ORDER.filter((l) => l === label);
      expect(occurrences, `${label} in WAITING_PIPELINE_ORDER`).toHaveLength(1);
    }
  });

  it('WAITING_PIPELINE_ORDER has no duplicate entries at all', () => {
    expect(WAITING_PIPELINE_ORDER).toHaveLength(new Set(WAITING_PIPELINE_ORDER).size);
  });

  it('dependency-limit sorts immediately after remediation-limit', () => {
    const remediation = WAITING_PIPELINE_ORDER.indexOf('waiting-for:remediation-limit');
    expect(remediation).toBeGreaterThanOrEqual(0);
    expect(WAITING_PIPELINE_ORDER[remediation + 1]).toBe(DEPENDENCY_LIMIT);
  });

  it('dependency-limit outranks dependencies', () => {
    expect(classify([DEPENDENCIES, DEPENDENCY_LIMIT])).toEqual({
      state: 'waiting',
      sourceLabel: DEPENDENCY_LIMIT,
    });
  });

  it('both gates classify into the waiting tier on their own', () => {
    expect(classify([DEPENDENCIES])).toEqual({
      state: 'waiting',
      sourceLabel: DEPENDENCIES,
    });
    expect(classify([DEPENDENCY_LIMIT])).toEqual({
      state: 'waiting',
      sourceLabel: DEPENDENCY_LIMIT,
    });
  });

  it('a dependency-blocked issue surfaces the gate, not the co-present agent:paused', () => {
    // The blocked branch applies `agent:paused` (pending tier) alongside the
    // gate; waiting must win so the operator sees WHY it is paused.
    expect(
      classify([DEPENDENCIES, 'agent:paused', 'workflow:speckit-bugfix']).sourceLabel,
    ).toBe(DEPENDENCIES);
  });

  it('an actively-rewriting PR-feedback state still outranks a dependency gate', () => {
    // #926 precedent — unchanged by #1211.
    expect(
      classify([DEPENDENCIES, 'waiting-for:address-pr-feedback']).sourceLabel,
    ).toBe('waiting-for:address-pr-feedback');
  });

  it('gate-vocabulary precondition: each new waiting-for:* has a completed:* partner', () => {
    const names = new Set(WORKFLOW_LABELS.map((d) => d.name));
    for (const label of [DEPENDENCIES, DEPENDENCY_LIMIT]) {
      const gate = label.slice('waiting-for:'.length);
      expect(names.has(label), `${label} in WORKFLOW_LABELS`).toBe(true);
      expect(
        names.has(`completed:${gate}`),
        `completed:${gate} in WORKFLOW_LABELS`,
      ).toBe(true);
    }
  });

  it('WORKFLOW_LABELS declares each dependency label exactly once', () => {
    for (const label of [
      DEPENDENCIES,
      DEPENDENCY_LIMIT,
      'completed:dependencies',
      'completed:dependency-limit',
    ]) {
      const defs = WORKFLOW_LABELS.filter((d) => d.name === label);
      expect(defs, `${label} definitions`).toHaveLength(1);
    }
  });
});
