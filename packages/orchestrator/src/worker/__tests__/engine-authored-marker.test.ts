/**
 * US3 (#1127, FR-005 / SC-005) — the standalone deterministic engine-authored
 * review marker-match helper.
 *
 * #1130 (out of scope here) wires this helper into `PrFeedbackMonitorService`
 * routing to EXCLUDE engine-authored review threads from external-feedback
 * processing. #1127 ships/pins the marker contract + this helper only; it does
 * NOT touch `PrFeedbackMonitorService` (Q4=B). The import-absence assertion
 * below (T032) proves the monitor is neither imported nor modified.
 *
 * Match rule (marker-family precedent — `clarification-markers.ts`): prefix
 * substring, case-sensitive ASCII, line-anchored at column 0; `> `-quoted
 * markers do NOT match.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  reviewBodyMarker,
  findingMarker,
  matchEngineAuthoredReviewMarker,
  commentCarriesEngineAuthoredReviewMarker,
  ENGINE_AUTHORED_REVIEW_MARKERS,
} from '../review-poster.js';

describe('matchEngineAuthoredReviewMarker (FR-005)', () => {
  it('matches an engine-authored review body (round marker at column 0)', () => {
    const body = [reviewBodyMarker(1), '', '## Engine review — Round 1', '', '- 🔴 Blocking: nope'].join(
      '\n',
    );
    expect(matchEngineAuthoredReviewMarker(body)).toBe(`<!-- generacy-engine-review`);
    expect(commentCarriesEngineAuthoredReviewMarker(body)).toBe(true);
  });

  it('matches an engine-authored inline finding comment (per-finding marker at column 0)', () => {
    const body = `${findingMarker('f-123')}\n🔵 Advisory (non-blocking): consider renaming`;
    expect(matchEngineAuthoredReviewMarker(body)).toBe('<!-- generacy-finding:');
    expect(commentCarriesEngineAuthoredReviewMarker(body)).toBe(true);
  });

  it('does NOT match a plain external-reviewer comment', () => {
    const body = 'This looks good but please rename `foo` to `bar` in utils.ts.';
    expect(matchEngineAuthoredReviewMarker(body)).toBeUndefined();
    expect(commentCarriesEngineAuthoredReviewMarker(body)).toBe(false);
  });

  it('does NOT match a `> `-quoted marker (line not anchored at column 0)', () => {
    const quotedBody = `> ${reviewBodyMarker(1)}`;
    const quotedFinding = `> ${findingMarker('f-9')}`;
    expect(matchEngineAuthoredReviewMarker(quotedBody)).toBeUndefined();
    expect(matchEngineAuthoredReviewMarker(quotedFinding)).toBeUndefined();
    expect(commentCarriesEngineAuthoredReviewMarker(quotedBody)).toBe(false);
  });

  it('is case-sensitive ASCII — an upper-cased marker does not match', () => {
    const body = '<!-- GENERACY-ENGINE-REVIEW round=1 -->';
    expect(matchEngineAuthoredReviewMarker(body)).toBeUndefined();
  });

  it('exposes exactly the two engine-authored marker prefixes', () => {
    expect([...ENGINE_AUTHORED_REVIEW_MARKERS]).toEqual([
      '<!-- generacy-engine-review',
      '<!-- generacy-finding:',
    ]);
  });
});

// ---------------------------------------------------------------------------
// T032 (SC-005) — #1127 must NOT import or modify `PrFeedbackMonitorService`.
// Static-import scan on the marker module's source (precedent:
// observer-independence.test.ts). The exclusion predicate wired into monitor
// routing is #1130's job; here the helper is standalone.
// ---------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const MARKER_MODULE = resolve(HERE, '..', 'review-poster.ts');

describe('marker-match helper is monitor-free (SC-005)', () => {
  it('review-poster.ts does not import or reference PrFeedbackMonitorService', () => {
    const source = readFileSync(MARKER_MODULE, 'utf8');
    expect(/pr-feedback-monitor-service/.test(source)).toBe(false);
    expect(/PrFeedbackMonitorService/.test(source)).toBe(false);
  });
});
