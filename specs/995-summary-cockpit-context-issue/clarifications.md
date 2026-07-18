# Clarifications: fix `cockpit_context` clarification-comment finder against label re-application

## Batch 1 — 2026-07-18

### Q1: Marker-less batch heading handling (FR-004)
**Context**: The spec's secondary defect is that not every question batch comment currently carries a leading HTML marker at column 0 — some batch comments emit `## ❓ Clarification questions — Batch 2` as their first line, with the `<!-- generacy-clarifications:N -->` marker only on a sibling comment. Under a marker-only finder, those marker-less batch comments would be invisible; the sibling would be returned instead (or nothing at all, if the sibling isn't a distinct comment). FR-004 explicitly leaves the fix strategy open. The Q1 answer decides (a) whether this PR includes correlation logic vs. defers to a poster-side fix, and (b) whether the poster needs to be updated in a companion PR before or after this fix lands.
**Question**: How should the finder handle a marker-less batch heading comment (`## ❓ Clarification questions — Batch N`) whose questions live in the same comment (no sibling)?
**Options**:
- A: Poster-side fix only — require the poster to emit a marker (`<!-- generacy-clarifications:N -->`) at column 0 on every batch comment. The finder stays marker-only. Companion issue tracks the poster change; this PR ships the finder change and relies on the poster being updated (either landed first, or accepted-post-hoc since existing batches will re-satisfy the marker over time). Simplest finder; punts on legacy batches until they age out.
- B: Finder-side fix only — extend the finder to *also* recognize the human-readable `## ❓ Clarification questions — Batch N` heading pattern as a marker-equivalent when no `CLARIFICATION_QUESTION_MARKERS` prefix is found on that comment. Poster-side unchanged. Robust against marker-less legacy batches; introduces a second matcher outside `matchClarificationQuestionMarker`, which FR-006 warns against ("no divergent matcher").
- C: Both — poster-side change for future batches AND finder-side heading recognition as belt-and-suspenders for legacy batches still in-flight. Highest coverage; largest scope (splits into companion PR + this one).
- D: Defer — leave FR-004 unresolved for this PR (marker-only finder, no correlation, no poster-side change). Marker-less batches remain unrecoverable but the primary bug (re-applied label) is fixed. Follow-up issue to decide (A) vs (B) once we see whether any live issues actually hit this path.

**Answer**: *Pending*

### Q2: Fallback strategy when no marker matches (FR-005)
**Context**: The fix keys off `CLARIFICATION_QUESTION_MARKERS`. If an issue has zero comments carrying any of those markers (pre-marker legacy issue, or a poster that never emitted one), a strict marker-only finder returns `null`. FR-005 leaves the choice between (a) a marker-only strategy that returns `null` cleanly and (b) a union strategy that falls back to the current label-timeline heuristic before giving up. Union preserves compatibility with any pre-marker legacy issues still in-flight; marker-only is simpler and matches the fix's spirit (positive identification over label-timeline heuristics). The spec author's own preference is marker-only.
**Question**: When no comment carries a `CLARIFICATION_QUESTION_MARKERS` marker, should the finder fall back to the current label-timeline heuristic before returning `null`?
**Options**:
- A: Marker-only — no fallback. Return `null` if no marker-tagged comment exists. Simpler, single strategy, matches the fix's spirit. Any pre-marker legacy issue would return `null` and fall through to `/cockpit:auto`'s existing `gh issue view` degradation path (same as today's broken behavior — so no net regression, just no *improvement* for those issues).
- B: Union — try marker-based first; on miss, apply the current label-timeline heuristic (post-label comment, skipping stage-status comments); return `null` only if both fail. Safer for legacy issues, keeps the failure-mode from re-appearing wherever markers are somehow absent. Cost: two strategies to reason about, but the fallback is exactly today's code path — no new complexity.
- C: Union with a hard deprecation window — same as B, but the timeline fallback logs a warning ("marker-less clarification comment; poster should be updated") so we can measure how many issues still need it and remove the fallback later.

**Answer**: *Pending*
