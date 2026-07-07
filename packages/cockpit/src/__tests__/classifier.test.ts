import { describe, expect, it } from 'vitest';
import { WORKFLOW_LABELS } from '@generacy-ai/workflow-engine';
import { classify } from '../state/classifier.js';
import { WAITING_PIPELINE_ORDER } from '../state/precedence.js';

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
      expect(classify(ordered).sourceLabel).toBe('waiting-for:spec-review');
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
