/**
 * #1164 T010 (SC-002 / SC-003 / FR-009) — conflicted-path allowlist charter.
 *
 * Defect 2: a resolution-scoped review over a long-lived branch that caught up
 * to its base names the whole `baseSha..headSha` parent-1 diff — dwarfing the
 * actual resolution with base-only files. Defect 3: the trivial-diff paragraph
 * fires for a small-but-valid scoped resolution and spuriously flags it.
 *
 * These tests pin the FR-003 allowlist rendering (name exactly the conflicted
 * paths, tell the agent to ignore everything else), the FR-004 trivial-diff
 * suppression for any windowed review, and the FR-009 fallback: a `ReviewScope`
 * without `conflictedPaths` still produces the pre-#1164 range charter.
 */
import { describe, expect, it } from 'vitest';
import { buildReviewCharter, type ReviewCharterInput } from '../review-charter.js';

const BASE: ReviewCharterInput = {
  profile: 'standard',
  sidecarRelPath: '.generacy/review-findings-acme_widgets_42.json',
  blockingSeverity: 'major',
  round: 1,
};

describe('#1164 review-charter — conflicted-path allowlist', () => {
  it('names exactly the conflicted paths and tells the agent to ignore all others (FR-003, SC-002)', () => {
    const charter = buildReviewCharter({
      ...BASE,
      diffWindow: {
        baseSha: 'base123',
        headSha: 'head456',
        conflictedPaths: ['packages/orchestrator/src/a.ts', 'packages/orchestrator/src/b.ts'],
      },
    });

    // Each conflicted path is listed.
    expect(charter).toContain('- packages/orchestrator/src/a.ts');
    expect(charter).toContain('- packages/orchestrator/src/b.ts');
    // The agent is told to inspect ONLY these and ignore everything else,
    // including base-branch changes — so 0 base-only files enter the review.
    expect(charter.toLowerCase()).toContain('inspect only these conflicted paths');
    expect(charter.toLowerCase()).toContain('ignore all other files');
    expect(charter.toLowerCase()).toContain('merged-in base branch');
    // The raw range must NOT appear — the allowlist replaces it.
    expect(charter).not.toContain('`base123..head456`');
  });

  it('omits the trivial-diff paragraph for a windowed review (FR-004, SC-003)', () => {
    const withAllowlist = buildReviewCharter({
      ...BASE,
      diffWindow: {
        baseSha: 'base123',
        headSha: 'head456',
        conflictedPaths: ['packages/orchestrator/src/a.ts'],
      },
    });
    const withRange = buildReviewCharter({
      ...BASE,
      diffWindow: { baseSha: 'base123', headSha: 'head456' },
    });

    // No trivial-diff flag on EITHER windowed variant.
    for (const charter of [withAllowlist, withRange]) {
      expect(charter).not.toContain('## Empty or trivial diff');
    }
  });

  it('still fires the trivial-diff paragraph on a round-1 whole-PR review (FR-004)', () => {
    const wholePr = buildReviewCharter(BASE);
    expect(wholePr).toContain('## Empty or trivial diff');
  });

  it('a ReviewScope with no conflictedPaths → pre-#1164 range charter, byte-for-byte (FR-009)', () => {
    const absent = buildReviewCharter({
      ...BASE,
      diffWindow: { baseSha: 'base123', headSha: 'head456' },
    });
    const empty = buildReviewCharter({
      ...BASE,
      diffWindow: { baseSha: 'base123', headSha: 'head456', conflictedPaths: [] },
    });

    // Empty allowlist behaves exactly like an absent one (fallback to the range).
    expect(empty).toBe(absent);
    expect(empty).toContain('`base123..head456`');
    expect(empty).not.toContain('Inspect ONLY these conflicted paths');
  });

  it('still forbids tests/builds and names the sidecar with an allowlist (FR-003/FR-005 unchanged)', () => {
    const charter = buildReviewCharter({
      ...BASE,
      diffWindow: { baseSha: 'aaa', headSha: 'bbb', conflictedPaths: ['src/x.ts'] },
    });
    expect(charter.toLowerCase()).toMatch(/do not run the test suite/);
    expect(charter).toContain('.generacy/review-findings-acme_widgets_42.json');
  });
});
