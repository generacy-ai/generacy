import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_REVIEW_KINDS,
  deriveArtifactReviewGeneration,
  deriveClarificationGeneration,
  deriveEscalationGeneration,
  deriveFilingGeneration,
  deriveImplementationReviewGeneration,
  deriveManualValidationGeneration,
  derivePhaseQueueGeneration,
  deriveScopeDrainedGeneration,
} from '../gates/index.js';

describe('per-gate-type generation helpers', () => {
  describe('deriveArtifactReviewGeneration (a)', () => {
    it('returns `<kind>:<headSha>` for spec-review', () => {
      expect(
        deriveArtifactReviewGeneration({ kind: 'spec-review', headSha: 'abc1234' }),
      ).toBe('spec-review:abc1234');
    });

    it.each([...ARTIFACT_REVIEW_KINDS])('handles kind=%s', (kind) => {
      expect(deriveArtifactReviewGeneration({ kind, headSha: 'deadbeef' })).toBe(
        `${kind}:deadbeef`,
      );
    });
  });

  describe('deriveEscalationGeneration (b)', () => {
    it('preserves colons inside labelOrState (e.g. "agent:error")', () => {
      expect(
        deriveEscalationGeneration({
          subtype: 'stalled',
          labelOrState: 'agent:error',
          counter: 3,
        }),
      ).toBe('stalled:agent:error:3');
    });

    it('handles a state-name labelOrState without colons', () => {
      expect(
        deriveEscalationGeneration({
          subtype: 'error',
          labelOrState: 'blocked',
          counter: 1,
        }),
      ).toBe('error:blocked:1');
    });
  });

  describe('deriveScopeDrainedGeneration (c)', () => {
    it('returns `<owner>/<repo>#<number>:<counter>`', () => {
      expect(
        deriveScopeDrainedGeneration({
          trackingIssueRef: { owner: 'generacy-ai', repo: 'generacy', number: 900 },
          counter: 2,
        }),
      ).toBe('generacy-ai/generacy#900:2');
    });
  });

  describe('simple-number helpers (d)', () => {
    it('deriveManualValidationGeneration returns String(phaseNumber)', () => {
      expect(deriveManualValidationGeneration({ phaseNumber: 2 })).toBe('2');
    });

    it('derivePhaseQueueGeneration returns String(phaseNumber)', () => {
      expect(derivePhaseQueueGeneration({ phaseNumber: 4 })).toBe('4');
    });
  });

  describe('single-field-verbatim helpers (e)', () => {
    it('deriveClarificationGeneration returns batchId verbatim', () => {
      expect(deriveClarificationGeneration({ batchId: 'batch-abc123' })).toBe('batch-abc123');
    });

    it('deriveFilingGeneration returns draftHash verbatim', () => {
      expect(deriveFilingGeneration({ draftHash: 'feedbeef1234' })).toBe('feedbeef1234');
    });

    it('deriveImplementationReviewGeneration returns headSha verbatim', () => {
      expect(deriveImplementationReviewGeneration({ headSha: 'def5678' })).toBe('def5678');
    });
  });
});
