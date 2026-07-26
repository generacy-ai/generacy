/**
 * Pure parser for the `<!-- generacy-cockpit:body-findings-unaddressed -->`
 * marker comment produced by Disposition C on a prior cycle (#1047).
 *
 * Contract: `specs/1047-problem-orchestrator-s-pr/contracts/body-findings-unaddressed-marker.md`.
 * Fail-open: any parse failure yields an empty acknowledgment set (which
 * means every body finding gates as if no prior notice existed).
 */

export const BODY_FINDINGS_UNADDRESSED_MARKER =
  '<!-- generacy-cockpit:body-findings-unaddressed -->';

export type AcknowledgedFindings = ReadonlySet<string>;

export interface AcknowledgmentEntry {
  reviewer: string;
  reviewId: number;
  findingIndex: number;
}

// Matches: `- \`<reviewer>\` review #<reviewId> finding <findingIndex>`
// The trailing `(files: ...)` decoration is ignored — identity is
// (reviewer, reviewId, index) per the contract.
const ENTRY_RE = /^- `([^`]+)` review #(\d+) finding (\d+)/m;

export function parseAcknowledgedFindings(
  commentBodies: readonly string[],
): AcknowledgedFindings {
  const matching = commentBodies.filter(body =>
    body.includes(BODY_FINDINGS_UNADDRESSED_MARKER),
  );
  if (matching.length === 0) return new Set();

  const newest = matching[matching.length - 1]!;
  const entries = parseEntries(newest);
  const keys = new Set<string>();
  for (const e of entries) {
    keys.add(`${e.reviewer}:${e.reviewId}:${e.findingIndex}`);
  }
  return keys;
}

function parseEntries(body: string): AcknowledgmentEntry[] {
  const lines = body.split('\n');
  const entries: AcknowledgmentEntry[] = [];
  for (const line of lines) {
    const match = line.match(ENTRY_RE);
    if (!match) continue;
    const reviewId = Number.parseInt(match[2]!, 10);
    const findingIndex = Number.parseInt(match[3]!, 10);
    if (!Number.isFinite(reviewId) || !Number.isFinite(findingIndex)) continue;
    entries.push({ reviewer: match[1]!, reviewId, findingIndex });
  }
  return entries;
}

/**
 * Parse a single Disposition-C marker comment body into its enumeration key
 * set. Returns an empty set when the marker is absent or no rows parse.
 *
 * Consumed by `applyDispositionC` (#1047 Finding 4) to decide whether a new
 * marker comment should be posted — it must be, unless some prior marker
 * already enumerates the exact same set of unaddressed findings.
 */
export function parseSingleMarkerEntries(body: string): AcknowledgedFindings {
  if (!body.includes(BODY_FINDINGS_UNADDRESSED_MARKER)) return new Set();
  const entries = parseEntries(body);
  const keys = new Set<string>();
  for (const e of entries) {
    keys.add(`${e.reviewer}:${e.reviewId}:${e.findingIndex}`);
  }
  return keys;
}
