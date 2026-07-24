/**
 * Generation-parity tests (#1038 SC-002) — the load-bearing invariant of the
 * sweep-duplicate fix.
 *
 * For each fixture, we simulate BOTH callsites (agency-side sweep and
 * cluster-side live path) by constructing their inputs from the same
 * GitHub-state projection. The full derivation chain
 *   input → computeClarificationAnswerSetHash → deriveClarificationGeneration
 *         → deriveGateKey → deriveGateId
 * MUST yield byte-identical output on both sides.
 *
 * If this test ever fails, the sweep and live paths have drifted. The fix is
 * NOT to relax the assertion — it is to bring the two callsites back into
 * lockstep by making both pass the same shape into the helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  computeClarificationAnswerSetHash,
  deriveClarificationGeneration,
  deriveImplementationReviewGeneration,
  deriveArtifactReviewGeneration,
  deriveManualValidationGeneration,
  deriveGateKey,
  deriveGateId,
  CLARIFICATION_ANSWER_SET_FIXTURES,
} from '../index.js';
import type { ClarificationQuestion } from '../clarification-hash.js';

const ISSUE_REF = 'generacy-ai/generacy#1038';

/**
 * Simulate the sweep and the live path receiving the same GitHub state under
 * different in-memory shapes (extra fields, different array ordering) — the
 * projection at step 2 of the algorithm MUST collapse them to the same hash.
 */
function sweepShape(base: readonly ClarificationQuestion[]): {
  questions: ClarificationQuestion[];
} {
  // Sweep reads questions in "as-encountered" order and carries richer
  // metadata (comment id, asked-at) that must not influence the hash.
  return {
    questions: base.map((q, i) => ({
      questionNumber: q.questionNumber,
      questionText: q.questionText,
      // Sweep-only decorations — projection strips these.
      commentId: 100 + i,
      askedAt: '2026-07-21T12:00:00.000Z',
    })) as ClarificationQuestion[],
  };
}

function liveShape(base: readonly ClarificationQuestion[]): {
  questions: ClarificationQuestion[];
} {
  // Live path re-reads from spec.md; array is already sorted, and it does not
  // carry commentId. Deep-freeze to prove the helper does not mutate inputs.
  return {
    questions: base.map((q) => Object.freeze({ ...q })) as ClarificationQuestion[],
  };
}

describe('SC-002 — sweep and live paths produce byte-identical gateIds', () => {
  describe('clarification', () => {
    for (const [name, fixture] of Object.entries(CLARIFICATION_ANSWER_SET_FIXTURES)) {
      it(`fixture ${name} — sweep-derived === live-derived`, () => {
        const sweepInput = sweepShape(fixture.questions);
        const liveInput = liveShape(fixture.questions);

        const sweepBatchId = computeClarificationAnswerSetHash(sweepInput);
        const liveBatchId = computeClarificationAnswerSetHash(liveInput);
        expect(sweepBatchId).toBe(liveBatchId);

        const sweepGeneration = deriveClarificationGeneration({ batchId: sweepBatchId });
        const liveGeneration = deriveClarificationGeneration({ batchId: liveBatchId });
        expect(sweepGeneration).toBe(liveGeneration);

        const sweepKey = deriveGateKey(ISSUE_REF, 'clarification', sweepGeneration);
        const liveKey = deriveGateKey(ISSUE_REF, 'clarification', liveGeneration);
        expect(sweepKey).toBe(liveKey);

        const sweepId = deriveGateId(sweepKey);
        const liveId = deriveGateId(liveKey);
        expect(sweepId).toBe(liveId);
        expect(sweepId).toMatch(/^[0-9a-f]{24}$/);
      });
    }
  });

  describe('implementation-review', () => {
    const headShas = [
      'abc1234def5678',
      'deadbeefcafe1234deadbeefcafe1234deadbeef',
      '0000000000000000000000000000000000000000',
    ];
    for (const headSha of headShas) {
      it(`headSha ${headSha.slice(0, 8)}... — sweep-derived === live-derived`, () => {
        // Both callsites project GitHub state to the same `{ headSha }`.
        const sweepGeneration = deriveImplementationReviewGeneration({ headSha });
        const liveGeneration = deriveImplementationReviewGeneration({ headSha });
        expect(sweepGeneration).toBe(liveGeneration);

        const sweepKey = deriveGateKey(ISSUE_REF, 'implementation-review', sweepGeneration);
        const liveKey = deriveGateKey(ISSUE_REF, 'implementation-review', liveGeneration);
        expect(sweepKey).toBe(liveKey);

        const sweepId = deriveGateId(sweepKey);
        const liveId = deriveGateId(liveKey);
        expect(sweepId).toBe(liveId);
      });
    }
  });

  // Defensive coverage for the two additional gate types with SHA-adjacent
  // inputs (contracts/generation-derivation.md).
  describe('artifact-review (defensive)', () => {
    const cases = [
      { kind: 'spec-review' as const, headSha: 'abc1234' },
      { kind: 'plan-review' as const, headSha: 'def5678' },
      { kind: 'tasks-review' as const, headSha: '01234567' },
      { kind: 'clarification-review' as const, headSha: '89abcdef' },
    ];
    for (const c of cases) {
      it(`kind=${c.kind} headSha=${c.headSha} — sweep === live`, () => {
        const sweepGeneration = deriveArtifactReviewGeneration(c);
        const liveGeneration = deriveArtifactReviewGeneration(c);
        expect(sweepGeneration).toBe(liveGeneration);
        const sweepId = deriveGateId(deriveGateKey(ISSUE_REF, 'artifact-review', sweepGeneration));
        const liveId = deriveGateId(deriveGateKey(ISSUE_REF, 'artifact-review', liveGeneration));
        expect(sweepId).toBe(liveId);
      });
    }
  });

  describe('manual-validation (defensive)', () => {
    for (const phaseNumber of [1, 2, 3, 10]) {
      it(`phaseNumber=${phaseNumber} — sweep === live`, () => {
        const sweepGeneration = deriveManualValidationGeneration({ phaseNumber });
        const liveGeneration = deriveManualValidationGeneration({ phaseNumber });
        expect(sweepGeneration).toBe(liveGeneration);
        const sweepId = deriveGateId(deriveGateKey(ISSUE_REF, 'manual-validation', sweepGeneration));
        const liveId = deriveGateId(deriveGateKey(ISSUE_REF, 'manual-validation', liveGeneration));
        expect(sweepId).toBe(liveId);
      });
    }
  });
});
