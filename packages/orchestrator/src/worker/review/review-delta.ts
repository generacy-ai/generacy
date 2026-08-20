import type { FindingsArtifact } from './findings-artifact.js';

/**
 * The base/head pair the re-review diff is scoped to, tagged by which selection
 * rule chose it.
 */
export type DeltaBase =
  | { source: 'resolution'; base: string; head: string } // FR-007 (pause-context SHAs)
  | { source: 'last-reviewed'; base: string; head: string } // FR-002
  | { source: 'full-diff'; base: string; head: string }; // FR-009 fallback (widened)

export interface ReviewDelta {
  base: DeltaBase;
  /** changed files between base.base..base.head; [] when base === head */
  files: string[];
  /** n+1 for verification; the fallback never resets to round 1 (Q5) */
  round: number;
}

/**
 * The `GitHubClient` slice `computeReviewDelta` needs. Kept minimal so unit
 * tests inject a tiny fake and the function stays decoupled from the full
 * client surface.
 */
export interface ReviewDeltaGitHub {
  getFilesChangedBetween(base: string, head: string): Promise<string[]>;
  getCurrentCommitSha(): Promise<string>;
  commitExistsInCheckout(sha: string): Promise<boolean>;
}

export interface ComputeReviewDeltaInput {
  github: ReviewDeltaGitHub;
  artifact: FindingsArtifact;
  /** #1131 populates these on a merge-conflict re-arm; read-side only here */
  pauseContext?: { resolutionBaseSha?: string; resolutionHeadSha?: string };
  /** default-branch base for the full-diff fallback */
  prBaseRef: string;
}

/**
 * FR-002 / FR-007 / FR-009: compute the delta the re-review is scoped to.
 *
 * Base-selection order (first that applies wins):
 *   1. `pauseContext.resolutionBaseSha && pauseContext.resolutionHeadSha`
 *      ⇒ `source: 'resolution'` (FR-007).
 *   2. `artifact.lastReviewedSha` **and** `commitExistsInCheckout(sha)`
 *      ⇒ `source: 'last-reviewed'`, head = `getCurrentCommitSha()` (FR-002).
 *   3. Otherwise ⇒ `source: 'full-diff'`, base = `prBaseRef`,
 *      head = `getCurrentCommitSha()` (FR-009 widened verification pass).
 *
 * Invariants:
 * - `round === artifact.round + 1` on every branch (Q5 — no round-1 reset).
 * - `base === head` ⇒ `files: []` (SC-001).
 * - A genuine git failure from `getFilesChangedBetween` propagates; only a
 *   *missing* `lastReviewedSha` (via `commitExistsInCheckout === false`)
 *   triggers the FR-009 fallback.
 */
export async function computeReviewDelta(
  input: ComputeReviewDeltaInput,
): Promise<ReviewDelta> {
  const { github, artifact, pauseContext, prBaseRef } = input;
  const round = artifact.round + 1;

  let base: DeltaBase;

  // 1. FR-007: pause-context resolution SHAs (highest priority).
  if (pauseContext?.resolutionBaseSha && pauseContext.resolutionHeadSha) {
    base = {
      source: 'resolution',
      base: pauseContext.resolutionBaseSha,
      head: pauseContext.resolutionHeadSha,
    };
  } else if (
    // 2. FR-002: artifact last-reviewed SHA, only if it still resolves.
    artifact.lastReviewedSha != null &&
    (await github.commitExistsInCheckout(artifact.lastReviewedSha))
  ) {
    base = {
      source: 'last-reviewed',
      base: artifact.lastReviewedSha,
      head: await github.getCurrentCommitSha(),
    };
  } else {
    // 3. FR-009: widened full-diff fallback (still a verification pass).
    base = {
      source: 'full-diff',
      base: prBaseRef,
      head: await github.getCurrentCommitSha(),
    };
  }

  // Identical SHAs ⇒ empty delta for free (SC-001).
  const files =
    base.base === base.head
      ? []
      : await github.getFilesChangedBetween(base.base, base.head);

  return { base, files, round };
}
