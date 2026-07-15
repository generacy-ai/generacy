/**
 * #941 FR-007 — unit coverage for the `applyLabels` guard.
 *
 * Verifies that:
 *  - `completed:<human-gate>` writes token-less throw `HumanGateCompletionUnauthorizedError`.
 *  - `completed:<human-gate>` writes with `AllowGateComplete.CockpitAdvance` pass through.
 *  - `completed:<WorkflowPhase>` writes pass through token-less.
 *  - Non-`completed:*` labels are unaffected.
 *  - Batched calls with any offending label reject atomically (no partial writes).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import {
  AllowGateComplete,
  HumanGateCompletionUnauthorizedError,
  LabelManager,
  isHumanGateCompletion,
} from '../label-manager.js';
import type { Logger } from '../types.js';

const HUMAN_GATE_SUFFIXES = [
  'clarification',
  'spec-review',
  'plan-review',
  'tasks-review',
  'implementation-review',
  'sibling-review',
  'merge-conflicts',
] as const;

const WORKFLOW_PHASES = [
  'specify',
  'clarify',
  'plan',
  'tasks',
  'implement',
  'validate',
] as const;

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
};

function makeGithub() {
  return {
    getIssue: vi.fn().mockResolvedValue({ labels: [] }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    listLabels: vi.fn().mockResolvedValue([]),
    createLabel: vi.fn().mockResolvedValue(undefined),
  };
}

function createLabelManager(github: ReturnType<typeof makeGithub>): LabelManager {
  return new LabelManager(
    github as unknown as GitHubClient,
    'owner',
    'repo',
    17,
    mockLogger as unknown as Logger,
  );
}

/**
 * Invoke the private `applyLabels` for guard testing. TypeScript private-field
 * escape via `as unknown as { applyLabels }` so the test drives the seam guard
 * without touching any public phase-transition method.
 */
async function callApplyLabels(
  lm: LabelManager,
  labels: string[],
  allow?: AllowGateComplete,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (lm as any).applyLabels(labels, allow);
}

describe('LabelManager guard (#941 FR-003)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockLogger.debug.mockReset();
    LabelManager.resetEnsureCacheForTests();
  });

  describe('predicate: isHumanGateCompletion', () => {
    for (const suffix of HUMAN_GATE_SUFFIXES) {
      it(`returns true for completed:${suffix}`, () => {
        expect(isHumanGateCompletion(`completed:${suffix}`)).toBe(true);
      });
    }

    for (const phase of WORKFLOW_PHASES) {
      it(`returns false for completed:${phase} (workflow phase, not a human gate)`, () => {
        expect(isHumanGateCompletion(`completed:${phase}`)).toBe(false);
      });
    }

    it('returns false for non-completed:* labels', () => {
      expect(isHumanGateCompletion('phase:plan')).toBe(false);
      expect(isHumanGateCompletion('waiting-for:implementation-review')).toBe(false);
      expect(isHumanGateCompletion('agent:paused')).toBe(false);
      expect(isHumanGateCompletion('failed:implement')).toBe(false);
      expect(isHumanGateCompletion('blocked:stuck-feedback-loop')).toBe(false);
    });
  });

  describe('token-less write of completed:<human-gate>', () => {
    for (const suffix of HUMAN_GATE_SUFFIXES) {
      it(`throws HumanGateCompletionUnauthorizedError for completed:${suffix}`, async () => {
        const github = makeGithub();
        const lm = createLabelManager(github);

        await expect(
          callApplyLabels(lm, [`completed:${suffix}`]),
        ).rejects.toBeInstanceOf(HumanGateCompletionUnauthorizedError);

        expect(github.addLabels).not.toHaveBeenCalled();
      });

      it(`error carries the offending label completed:${suffix}`, async () => {
        const github = makeGithub();
        const lm = createLabelManager(github);

        try {
          await callApplyLabels(lm, [`completed:${suffix}`]);
          throw new Error('expected throw');
        } catch (err) {
          expect(err).toBeInstanceOf(HumanGateCompletionUnauthorizedError);
          expect((err as HumanGateCompletionUnauthorizedError).label).toBe(
            `completed:${suffix}`,
          );
          expect(
            (err as HumanGateCompletionUnauthorizedError).allowedTokens,
          ).toContain(AllowGateComplete.CockpitAdvance);
        }
      });
    }
  });

  describe('write of completed:<human-gate> WITH AllowGateComplete.CockpitAdvance token', () => {
    for (const suffix of HUMAN_GATE_SUFFIXES) {
      it(`passes through to github.addLabels for completed:${suffix}`, async () => {
        const github = makeGithub();
        const lm = createLabelManager(github);

        await callApplyLabels(
          lm,
          [`completed:${suffix}`],
          AllowGateComplete.CockpitAdvance,
        );

        expect(github.addLabels).toHaveBeenCalledTimes(1);
        expect(github.addLabels).toHaveBeenCalledWith('owner', 'repo', 17, [
          `completed:${suffix}`,
        ]);
      });
    }
  });

  describe('token-less write of completed:<WorkflowPhase>', () => {
    for (const phase of WORKFLOW_PHASES) {
      it(`passes through for completed:${phase}`, async () => {
        const github = makeGithub();
        const lm = createLabelManager(github);

        await callApplyLabels(lm, [`completed:${phase}`]);

        expect(github.addLabels).toHaveBeenCalledTimes(1);
        expect(github.addLabels).toHaveBeenCalledWith('owner', 'repo', 17, [
          `completed:${phase}`,
        ]);
      });
    }
  });

  describe('non-completed:* labels are unaffected', () => {
    const cases = [
      'phase:plan',
      'waiting-for:implementation-review',
      'agent:paused',
      'agent:in-progress',
      'agent:error',
      'failed:implement',
      'blocked:stuck-feedback-loop',
    ];

    for (const label of cases) {
      it(`passes through token-less for ${label}`, async () => {
        const github = makeGithub();
        const lm = createLabelManager(github);

        await callApplyLabels(lm, [label]);

        expect(github.addLabels).toHaveBeenCalledTimes(1);
        expect(github.addLabels).toHaveBeenCalledWith('owner', 'repo', 17, [label]);
      });
    }
  });

  describe('batched calls reject atomically', () => {
    it('throws and writes nothing when any label in the batch is completed:<human-gate>', async () => {
      const github = makeGithub();
      const lm = createLabelManager(github);

      await expect(
        callApplyLabels(lm, ['agent:paused', 'completed:implementation-review']),
      ).rejects.toBeInstanceOf(HumanGateCompletionUnauthorizedError);

      expect(github.addLabels).not.toHaveBeenCalled();
    });

    it('passes when the same batch is called with AllowGateComplete.CockpitAdvance', async () => {
      const github = makeGithub();
      const lm = createLabelManager(github);

      await callApplyLabels(
        lm,
        ['agent:paused', 'completed:implementation-review'],
        AllowGateComplete.CockpitAdvance,
      );

      expect(github.addLabels).toHaveBeenCalledTimes(1);
      expect(github.addLabels).toHaveBeenCalledWith('owner', 'repo', 17, [
        'agent:paused',
        'completed:implementation-review',
      ]);
    });

    it('reports the FIRST offending label found in a batch', async () => {
      const github = makeGithub();
      const lm = createLabelManager(github);

      try {
        await callApplyLabels(lm, [
          'agent:paused',
          'completed:spec-review',
          'completed:implementation-review',
        ]);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(HumanGateCompletionUnauthorizedError);
        expect((err as HumanGateCompletionUnauthorizedError).label).toBe(
          'completed:spec-review',
        );
      }

      expect(github.addLabels).not.toHaveBeenCalled();
    });
  });
});
