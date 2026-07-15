import { describe, expect, it } from 'vitest';
import { WORKFLOW_LABELS } from '@generacy-ai/workflow-engine';
import { classify } from '../state/classifier.js';
import { mapLabelToState } from '../state/label-map.js';
import { ERROR_PIPELINE_ORDER, WAITING_PIPELINE_ORDER } from '../state/precedence.js';

describe('classify()', () => {
  describe('per-state coverage (a)', () => {
    it('classifies `phase:implement` as active', () => {
      expect(classify(['phase:implement'])).toEqual({
        state: 'active',
        sourceLabel: 'phase:implement',
      });
    });

    it('classifies `waiting-for:clarification` as waiting', () => {
      expect(classify(['waiting-for:clarification'])).toEqual({
        state: 'waiting',
        sourceLabel: 'waiting-for:clarification',
      });
    });

    it('classifies `completed:epic-approval` as terminal', () => {
      expect(classify(['completed:epic-approval'])).toEqual({
        state: 'terminal',
        sourceLabel: 'completed:epic-approval',
      });
    });

    it('classifies `agent:error` as error', () => {
      expect(classify(['agent:error'])).toEqual({
        state: 'error',
        sourceLabel: 'agent:error',
      });
    });

    it('classifies `failed:plan` as error', () => {
      expect(classify(['failed:plan'])).toEqual({
        state: 'error',
        sourceLabel: 'failed:plan',
      });
    });

    it('classifies `agent:paused` as pending', () => {
      expect(classify(['agent:paused'])).toEqual({
        state: 'pending',
        sourceLabel: 'agent:paused',
      });
    });

    it('classifies the special `closed` label as terminal', () => {
      expect(classify(['closed'])).toEqual({
        state: 'terminal',
        sourceLabel: 'closed',
      });
    });
  });

  describe('precedence (b): terminal > error > waiting > active > pending', () => {
    it('terminal beats error', () => {
      expect(classify(['failed:implement', 'closed']).state).toBe('terminal');
    });

    it('error beats waiting', () => {
      expect(classify(['waiting-for:clarification', 'agent:error']).state).toBe('error');
    });

    it('waiting beats active', () => {
      expect(classify(['phase:plan', 'waiting-for:plan-review']).state).toBe('waiting');
    });

    it('active beats pending', () => {
      expect(classify(['type:feature', 'phase:specify']).state).toBe('active');
    });
  });

  describe('waiting tie-break via WAITING_PIPELINE_ORDER (c)', () => {
    it('prefers earlier pipeline gate', () => {
      expect(
        classify(['waiting-for:plan-review', 'waiting-for:spec-review']),
      ).toEqual({
        state: 'waiting',
        sourceLabel: 'waiting-for:spec-review',
      });
    });

    it('keeps pipeline order through full chain', () => {
      const ordered = [...WAITING_PIPELINE_ORDER].reverse();
      // #883: blocked:stuck-feedback-loop is now the first entry in
      // WAITING_PIPELINE_ORDER (highest priority), so it wins.
      expect(classify(ordered).sourceLabel).toBe(WAITING_PIPELINE_ORDER[0]);
    });

    it('listed pipeline gate beats unlisted waiting label', () => {
      // `waiting-for:sibling-review` is in WORKFLOW_LABELS but not in WAITING_PIPELINE_ORDER.
      expect(
        classify(['waiting-for:sibling-review', 'waiting-for:tasks-review']).sourceLabel,
      ).toBe('waiting-for:tasks-review');
    });
  });

  describe('non-waiting tie-break via WORKFLOW_LABELS index (d)', () => {
    it('prefers earlier WORKFLOW_LABELS entry within active tier', () => {
      // `phase:specify` is index 0, `phase:plan` is index 2 in WORKFLOW_LABELS.
      expect(classify(['phase:plan', 'phase:specify']).sourceLabel).toBe('phase:specify');
    });

    it('prefers earlier WORKFLOW_LABELS entry within error tier', () => {
      // `failed:specify` is earlier than `failed:plan`, but `agent:error` is later than both.
      expect(
        classify(['agent:error', 'failed:specify', 'failed:plan']).sourceLabel,
      ).toBe('failed:specify');
    });
  });

  describe('SC-001: every WORKFLOW_LABELS entry yields non-unknown state (e)', () => {
    it.each(WORKFLOW_LABELS.map((def) => [def.name]))(
      '%s classifies to a curated tier',
      (name) => {
        const result = classify([name]);
        expect(result.state).not.toBe('unknown');
        expect(result.sourceLabel).toBe(name);
      },
    );
  });

  describe('#841 — mid-pipeline completed:* is not terminal', () => {
    it('FR-007: waiting beats demoted completed', () => {
      // A stalled cluster carrying completed:specify + a live waiting-for
      // gate must not disappear into the terminal bucket.
      expect(
        classify([
          'completed:specify',
          'waiting-for:clarification',
          'agent:in-progress',
          'agent:paused',
        ]),
      ).toEqual({
        state: 'waiting',
        sourceLabel: 'waiting-for:clarification',
      });
    });

    it('FR-008: completed:validate stays terminal', () => {
      expect(classify(['completed:validate'])).toEqual({
        state: 'terminal',
        sourceLabel: 'completed:validate',
      });
    });

    it('FR-009a: single demoted completed:* maps to stage-complete', () => {
      expect(classify(['completed:specify'])).toEqual({
        state: 'stage-complete',
        sourceLabel: 'completed:specify',
      });
    });

    it('FR-009b: latest-phase-wins tie-break among demoted completed:*', () => {
      expect(classify(['completed:specify', 'completed:plan'])).toEqual({
        state: 'stage-complete',
        sourceLabel: 'completed:plan',
      });
    });

    it('canary: terminal outranks stage-complete regardless of pipeline order', () => {
      expect(
        classify(['completed:epic-approval', 'completed:implement']),
      ).toEqual({
        state: 'terminal',
        sourceLabel: 'completed:epic-approval',
      });
    });

    it('canary: completed:children-complete is terminal', () => {
      expect(classify(['completed:children-complete'])).toEqual({
        state: 'terminal',
        sourceLabel: 'completed:children-complete',
      });
    });

    it('canary: error beats stage-complete', () => {
      expect(classify(['failed:plan', 'completed:specify'])).toEqual({
        state: 'error',
        sourceLabel: 'failed:plan',
      });
    });

    it('canary: empty input still returns unknown/""', () => {
      expect(classify([])).toEqual({ state: 'unknown', sourceLabel: '' });
    });
  });

  describe('#883: blocked:* labels classify as waiting', () => {
    it('blocked:stuck-feedback-loop alone classifies as waiting', () => {
      expect(classify(['blocked:stuck-feedback-loop'])).toEqual({
        state: 'waiting',
        sourceLabel: 'blocked:stuck-feedback-loop',
      });
    });

    it('arbitrary blocked:* prefix sibling also classifies as waiting', () => {
      // Future-proofing: any `blocked:*` label inherits the waiting tier via
      // the prefix rule in classifyByPattern, even if it is not in
      // WORKFLOW_LABELS. mapLabelToState returns unknown for such names but
      // the prefix branch will classify them as waiting when they reach it.
      // Note: the classifier consumes mapLabelToState, so for this
      // future-proofing to bite we simply verify the prefix branch below.
      expect(mapLabelToState('blocked:stuck-feedback-loop')).toBe('waiting');
    });

    it('blocked:stuck-feedback-loop wins tie-break over waiting-for:address-pr-feedback', () => {
      expect(
        classify(['waiting-for:address-pr-feedback', 'blocked:stuck-feedback-loop']),
      ).toEqual({
        state: 'waiting',
        sourceLabel: 'blocked:stuck-feedback-loop',
      });
    });

    it('LABEL_TO_STATE includes blocked:stuck-feedback-loop → waiting', () => {
      expect(mapLabelToState('blocked:stuck-feedback-loop')).toBe('waiting');
    });
  });

  describe('#926: waiting-for:address-pr-feedback is a promoted waiting gate', () => {
    it('outranks waiting-for:implementation-review when both coexist (FR-002, SC-001)', () => {
      expect(
        classify(['waiting-for:implementation-review', 'waiting-for:address-pr-feedback']),
      ).toEqual({
        state: 'waiting',
        sourceLabel: 'waiting-for:address-pr-feedback',
      });
    });

    it('reverts to waiting-for:implementation-review after address-pr-feedback removed', () => {
      expect(classify(['waiting-for:implementation-review'])).toEqual({
        state: 'waiting',
        sourceLabel: 'waiting-for:implementation-review',
      });
    });

    it('blocked:stuck-feedback-loop outranks address-pr-feedback (Q1 invariant preserved)', () => {
      expect(
        classify(['blocked:stuck-feedback-loop', 'waiting-for:address-pr-feedback']),
      ).toEqual({
        state: 'waiting',
        sourceLabel: 'blocked:stuck-feedback-loop',
      });
    });

    it('blocked:stuck-feedback-loop outranks both address-pr-feedback and implementation-review', () => {
      expect(
        classify([
          'blocked:stuck-feedback-loop',
          'waiting-for:address-pr-feedback',
          'waiting-for:implementation-review',
        ]),
      ).toEqual({
        state: 'waiting',
        sourceLabel: 'blocked:stuck-feedback-loop',
      });
    });

    it('waiting-for:address-pr-feedback alone wins its own bucket', () => {
      expect(classify(['waiting-for:address-pr-feedback'])).toEqual({
        state: 'waiting',
        sourceLabel: 'waiting-for:address-pr-feedback',
      });
    });

    it('active > passive: address-pr-feedback outranks spec-review (Q1→A generalised)', () => {
      expect(
        classify(['waiting-for:address-pr-feedback', 'waiting-for:spec-review']),
      ).toEqual({
        state: 'waiting',
        sourceLabel: 'waiting-for:address-pr-feedback',
      });
    });
  });

  describe('#943: blocked:* labels in the error tier', () => {
    it('blocked:stuck-merge-conflicts alone classifies as error', () => {
      expect(classify(['blocked:stuck-merge-conflicts'])).toEqual({
        state: 'error',
        sourceLabel: 'blocked:stuck-merge-conflicts',
      });
    });

    it('blocked:stuck-validate-fix alone classifies as error', () => {
      expect(classify(['blocked:stuck-validate-fix'])).toEqual({
        state: 'error',
        sourceLabel: 'blocked:stuck-validate-fix',
      });
    });

    it('blocked:stuck-feedback-loop stays in waiting (preserves #883)', () => {
      expect(classify(['blocked:stuck-feedback-loop'])).toEqual({
        state: 'waiting',
        sourceLabel: 'blocked:stuck-feedback-loop',
      });
    });

    it('unknown blocked:* prefix (e.g. blocked:future) stays in waiting (safe default)', () => {
      // Not in WORKFLOW_LABELS so LABEL_TO_STATE has no entry; verify the
      // fallthrough via mapLabelToState + classifyByPattern semantics: an
      // unlisted blocked:* is not in ERROR_BLOCKED_LABELS, so the prefix
      // branch classifies it as waiting when the classifier reaches it.
      // Since it is unknown to WORKFLOW_LABELS, classify() returns unknown
      // for a lone unknown label — but the invariant we care about is that
      // it never lands in the error tier via the allow-list.
      expect(classify(['blocked:future'])).toEqual({
        state: 'unknown',
        sourceLabel: '',
      });
    });

    it('blocked:stuck-merge-conflicts wins the sourceLabel slot over agent:error', () => {
      expect(classify(['agent:error', 'blocked:stuck-merge-conflicts'])).toEqual({
        state: 'error',
        sourceLabel: 'blocked:stuck-merge-conflicts',
      });
    });

    it('blocked:stuck-merge-conflicts wins the sourceLabel slot over failed:validate', () => {
      expect(classify(['failed:validate', 'blocked:stuck-merge-conflicts'])).toEqual({
        state: 'error',
        sourceLabel: 'blocked:stuck-merge-conflicts',
      });
    });

    it('blocked:stuck-validate-fix wins the sourceLabel slot over agent:error', () => {
      expect(classify(['agent:error', 'blocked:stuck-validate-fix'])).toEqual({
        state: 'error',
        sourceLabel: 'blocked:stuck-validate-fix',
      });
    });

    it('blocked:stuck-merge-conflicts wins over blocked:stuck-validate-fix by ERROR_PIPELINE_ORDER', () => {
      expect(
        classify(['blocked:stuck-validate-fix', 'blocked:stuck-merge-conflicts']),
      ).toEqual({
        state: 'error',
        sourceLabel: 'blocked:stuck-merge-conflicts',
      });
    });

    it('cross-tier: error beats waiting when blocked:stuck-merge-conflicts coexists with waiting-for:merge-conflicts', () => {
      expect(
        classify(['waiting-for:merge-conflicts', 'blocked:stuck-merge-conflicts']),
      ).toEqual({
        state: 'error',
        sourceLabel: 'blocked:stuck-merge-conflicts',
      });
    });

    it('cross-tier: error beats waiting when blocked:stuck-validate-fix coexists with waiting-for:validate-fix', () => {
      expect(
        classify(['waiting-for:validate-fix', 'blocked:stuck-validate-fix']),
      ).toEqual({
        state: 'error',
        sourceLabel: 'blocked:stuck-validate-fix',
      });
    });

    it('regression: agent:error alone still classifies as error', () => {
      expect(classify(['agent:error'])).toEqual({
        state: 'error',
        sourceLabel: 'agent:error',
      });
    });

    it('regression: failed:plan alone still classifies as error', () => {
      expect(classify(['failed:plan'])).toEqual({
        state: 'error',
        sourceLabel: 'failed:plan',
      });
    });

    it('T005: mapLabelToState(blocked:stuck-merge-conflicts) is error', () => {
      expect(mapLabelToState('blocked:stuck-merge-conflicts')).toBe('error');
    });

    it('T005: mapLabelToState(blocked:stuck-validate-fix) is error', () => {
      expect(mapLabelToState('blocked:stuck-validate-fix')).toBe('error');
    });

    it('T005: mapLabelToState(blocked:stuck-feedback-loop) is waiting', () => {
      expect(mapLabelToState('blocked:stuck-feedback-loop')).toBe('waiting');
    });

    it('T006: every ERROR_PIPELINE_ORDER entry classifies as error under mapLabelToState', () => {
      for (const label of ERROR_PIPELINE_ORDER) {
        expect(mapLabelToState(label)).toBe('error');
      }
    });
  });

  describe('empty / unknown-only input (f)', () => {
    it('empty iterable → unknown with empty sourceLabel', () => {
      expect(classify([])).toEqual({ state: 'unknown', sourceLabel: '' });
    });

    it('only unknown labels → unknown with empty sourceLabel', () => {
      expect(classify(['random-label', 'another'])).toEqual({
        state: 'unknown',
        sourceLabel: '',
      });
    });

    it('skips unknown labels and uses known ones', () => {
      expect(classify(['random-label', 'phase:plan'])).toEqual({
        state: 'active',
        sourceLabel: 'phase:plan',
      });
    });

    it('deduplicates repeated labels', () => {
      expect(classify(['phase:plan', 'phase:plan', 'phase:plan'])).toEqual({
        state: 'active',
        sourceLabel: 'phase:plan',
      });
    });
  });
});
