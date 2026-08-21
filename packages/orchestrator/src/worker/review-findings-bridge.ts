/**
 * Pure bridge from the engine-written `ReviewArtifact` sidecar (#1124) into the
 * `FindingsArtifact` the `ReviewPoster` consumes (#1125). Zero I/O — the
 * `readFindingsArtifact` closure in `claude-cli-worker.ts` supplies the sidecar
 * and the resolved `blockingSeverity`; this module does only the shape transform
 * (#1156 FR-002/FR-003, D-2/D-3).
 */
import { createHash } from 'node:crypto';

import { SEVERITY_RANK, type ReviewArtifact, type Severity } from './review-artifact.js';
import type { FindingsArtifact } from './review-findings-artifact.js';

/**
 * Stable per-finding marker (FR-003, Q2=A): first 24 hex chars of
 * `sha256(file + '\0' + title)`. `ReviewArtifact` findings carry no id, so key on
 * `file`+`title` ("this problem in this file") — stable across rounds through
 * `line`/`detail` drift so re-review thread matching resolves the right thread.
 * The `\0` separator prevents `("ab","c")`/`("a","bc")` boundary collisions.
 */
export function synthesizeMarker(file: string, title: string): string {
  return createHash('sha256').update(`${file}\0${title}`).digest('hex').slice(0, 24);
}

/**
 * Bridge the engine-written `ReviewArtifact` into the poster's `FindingsArtifact`
 * (FR-002). Per finding: synthesize a stable marker, join title+detail into the
 * comment text, map severity to blocking/advisory via the configured
 * `blockingSeverity` threshold (single source of truth with `computeVerdict` —
 * D-2), carry an anchor only when `line` is present, and mark resolved when the
 * finding's status is `resolved`. Verdict passes through. Never drops a finding
 * (SC-002); never throws on schema-valid input.
 */
export function bridgeReviewArtifact(
  artifact: ReviewArtifact,
  blockingSeverity: Severity,
): FindingsArtifact {
  const threshold = SEVERITY_RANK[blockingSeverity];

  return {
    verdict: artifact.verdict,
    findings: artifact.findings.map((finding) => ({
      marker: synthesizeMarker(finding.file, finding.title),
      text: `${finding.title}\n\n${finding.detail}`,
      severity: SEVERITY_RANK[finding.severity] >= threshold ? 'blocking' : 'advisory',
      ...(finding.line !== undefined
        ? { anchor: { file: finding.file, line: finding.line } }
        : {}),
      resolved: finding.status === 'resolved',
    })),
  };
}
