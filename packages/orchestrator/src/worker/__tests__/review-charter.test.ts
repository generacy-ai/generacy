import { describe, expect, it } from 'vitest';
import { buildReviewCharter, type ReviewCharterInput } from '../review-charter.js';

const BASE: ReviewCharterInput = {
  profile: 'standard',
  sidecarRelPath: '.generacy/review-findings-acme_widgets_42.json',
  blockingSeverity: 'major',
  round: 1,
};

describe('buildReviewCharter', () => {
  it('forbids running tests or builds (FR-003)', () => {
    const charter = buildReviewCharter(BASE).toLowerCase();
    expect(charter).toMatch(/do not run the test suite/);
    expect(charter).toMatch(/do not run any build/);
  });

  it('instructs flagging an empty/trivial diff as a finding at/above blockingSeverity (FR-004)', () => {
    const charter = buildReviewCharter(BASE);
    expect(charter.toLowerCase()).toMatch(/empty.*diff|diff.*empty|trivial/);
    // Names the configured blocking severity as the floor for the empty-diff finding.
    expect(charter).toContain('`major`');
  });

  it('names the sidecar path and describes the ReviewFinding[] shape (FR-005)', () => {
    const charter = buildReviewCharter(BASE);
    expect(charter).toContain('.generacy/review-findings-acme_widgets_42.json');
    expect(charter).toContain('findings');
    for (const field of ['severity', 'file', 'line', 'title', 'detail', 'round', 'status']) {
      expect(charter).toContain(`\`${field}\``);
    }
  });

  it('does NOT ask the agent to emit a verdict (engine recomputes it, FR-007)', () => {
    const charter = buildReviewCharter(BASE).toLowerCase();
    expect(charter).toMatch(/do not include a verdict|engine computes the verdict/);
  });

  it('verification profile adds "needs verification" instructions; standard does not', () => {
    const standard = buildReviewCharter({ ...BASE, profile: 'standard' });
    const verification = buildReviewCharter({ ...BASE, profile: 'verification' });
    expect(standard.toLowerCase()).not.toContain('needs verification');
    expect(verification.toLowerCase()).toContain('needs verification');
  });

  it('is deterministic and includes the round number', () => {
    expect(buildReviewCharter(BASE)).toBe(buildReviewCharter(BASE));
    expect(buildReviewCharter({ ...BASE, round: 3 })).toContain('round 3');
  });

  describe('#1131 resolution-scoped diff window', () => {
    it('names the exact baseSha..headSha range and restricts the review to it (FR-002, SC-002)', () => {
      const charter = buildReviewCharter({
        ...BASE,
        diffWindow: { baseSha: 'base123', headSha: 'head456' },
      });
      expect(charter).toContain('`base123..head456`');
      // The window is exclusive: the agent is told to ignore anything outside it.
      expect(charter.toLowerCase()).toMatch(/only.*range|ignore files and changes outside/);
      expect(charter.toLowerCase()).toContain('merge-conflict');
    });

    it('still forbids tests/builds and names the sidecar when scoped (FR-003/FR-005 unchanged)', () => {
      const charter = buildReviewCharter({
        ...BASE,
        diffWindow: { baseSha: 'aaa', headSha: 'bbb' },
      });
      expect(charter.toLowerCase()).toMatch(/do not run the test suite/);
      expect(charter).toContain('.generacy/review-findings-acme_widgets_42.json');
    });

    it('absent diffWindow → byte-identical to the whole-PR charter (FR-010)', () => {
      const withUndefined = buildReviewCharter({ ...BASE, diffWindow: undefined });
      expect(withUndefined).toBe(buildReviewCharter(BASE));
      expect(withUndefined).not.toContain('..');
    });
  });
});
