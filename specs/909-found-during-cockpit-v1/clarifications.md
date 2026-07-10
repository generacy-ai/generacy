# Clarifications: Marker-based exclusion in clarification answer-scanner + explainer copy fix

**Issue**: [#909](https://github.com/generacy-ai/generacy/issues/909)
**Branch**: `909-found-during-cockpit-v1`

## Batch 1 — 2026-07-10

### Q1: Marker match semantics
**Context**: FR-101 lists three marker strings including `<!-- generacy-stage:clarification -->` verbatim (with a trailing space + `-->`). But the actual batch questions comment on issue #826 uses `<!-- generacy-stage:clarification-batch-1 -->` (with a `-batch-1` suffix inserted before the close), and existing `isQuestionComment` at `clarification-poster.ts:216` uses the looser prefix substring `<!-- generacy-stage:`. Two implementers would read FR-101 differently: one might do `body.includes('<!-- generacy-stage:clarification -->')` (misses the batch-1 variant), another might do `body.includes('<!-- generacy-stage:clarification')` (catches it). SC-001/SC-002 depend on the snappoll#4 fixture matching — and its marker is `<!-- generacy-stage:clarification-batch-1 -->`. The impl must know which rule to use.
**Question**: What is the exact matching rule for the FR-101 marker set?
**Options**:
- A: Exact-string containment — `body.includes('<!-- generacy-stage:clarification -->')` etc. Fails on the `-batch-1` variant unless the batch marker is added as its own entry.
- B: Prefix substring — `body.includes('<!-- generacy-stage:clarification')`, `body.includes('<!-- generacy-clarifications:')`, `body.includes('<!-- generacy-cockpit:clarifications-batch:')`. Matches every dialect that shares the documented prefix; case-sensitive, ASCII.
- C: Anchored regex per marker — e.g. `/<!--\s*generacy-stage:clarification[^\s>]*\s*-->/`. Guards against accidental substring hits elsewhere in the body but adds one regex per marker.

**Answer**: *Pending*

### Q2: Relationship with existing `isQuestionComment` marker checks
**Context**: `isQuestionComment` at `clarification-poster.ts:210-233` already contains three marker substring checks (`<!-- generacy-clarifications:`, `<!-- generacy-clarification:`, `<!-- generacy-stage:`) plus content-shape sniffs (`**Question**:`, `**Context**:`, `**Options**:`, `## Clarification Questions` heading). The new FR-101 `commentCarriesQuestionMarker` predicate covers the marker half. FR-106 explicitly preserves the content-shape sniff inside `parseAnswersFromComments` as belt-and-suspenders. The spec is silent on whether the marker substrings inside `isQuestionComment` stay, move, or become a call to the new predicate — which affects SC-007's "0 hardcoded markers" claim and the "single source" invariant in FR-108.
**Question**: How should the new predicate relate to the existing `isQuestionComment` marker checks?
**Options**:
- A: Standalone. New predicate lives beside `isQuestionComment`; the three marker substring checks stay duplicated in `isQuestionComment` (lines 212-216). SC-007's grep guard must scope out `isQuestionComment` explicitly, or the duplication is treated as pre-existing debt.
- B: Delegate. `isQuestionComment` calls `commentCarriesQuestionMarker(body)` as its first branch; the three inline `.includes()` calls in lines 212-216 are deleted. Content-shape branches (`### Q<n>:` split + `**Question**:` etc.) stay. FR-108's "single source" holds across the whole file.
- C: Two constants. Keep `MARKER_PREFIX` (used by `clarificationMarker()` for posting) separate from the FR-108 marker-set constant (used by exclusion). Neither `isQuestionComment` nor exclusion may hardcode a string; both consume the constant.

**Answer**: *Pending*

### Q3: Quoted-marker edge case (US4 regression risk)
**Context**: FR-102 says exclude a comment if it "contains" any FR-101 marker. GitHub's `>` block-quote is verbatim, so a trusted human whose answer comment quotes the bot's questions comment (e.g. `> <!-- generacy-stage:clarification -->\n> ### Q1: Topic\n\nQ1: A\nQ2: B`) triggers the exclusion and silently drops their answers. This is exactly the US4 regression the spec forbids, but only on the (real, observed in practice) quoted-marker path. Options range from "accept as edge case" to "match only when the marker isn't inside a `>` quote."
**Question**: When a trusted human answer comment quotes an FR-101 marker inside a block quote, what should the answer-scanner do?
**Options**:
- A: Accept the exclusion. Documented edge case; operator re-posts the answer without the quote. Simplest, matches "substring anywhere" semantics.
- B: Match markers only at column 0 of any line (no leading whitespace, no `>` prefix). Preserves the exclusion for engine-authored bodies and admits quoted markers in human answers. Trivial regex tweak.
- C: Match markers only when the marker is on the first non-whitespace line of the body. Strictest — only counts as "engine-authored" if the marker leads the comment.

**Answer**: *Pending*

### Q4: `commentCarriesQuestionMarker` + FR-108 constant location and export shape
**Context**: FR-108 requires "a single exported constant (or a single predicate)" so future marker additions land in one place. SC-007 additionally forbids new call sites hardcoding a marker string in `packages/orchestrator/src/worker/`. Neither pins the file, the export name, or whether the constant/predicate is exported from an existing module or a new one. This affects test import paths, package exports (if the shared package is `@generacy-ai/workflow-engine`), and how downstream surfaces (clarify-resume, pr-feedback) would reuse the predicate later.
**Question**: Where does the FR-108 constant + `commentCarriesQuestionMarker` predicate live?
**Options**:
- A: Alongside existing helpers in `packages/orchestrator/src/worker/clarification-poster.ts`. Both `commentCarriesQuestionMarker` and `CLARIFICATION_QUESTION_MARKERS` are exported from the same module; test file is the existing `clarification-poster.test.ts`.
- B: New module `packages/orchestrator/src/worker/clarification-markers.ts` exporting both symbols; `clarification-poster.ts` re-exports for convenience. Cleaner boundary if future surfaces need the predicate.
- C: Package-boundary lift — move to `@generacy-ai/workflow-engine` (or a new tiny `@generacy-ai/comment-markers` package) so cross-package consumers can adopt it without importing from orchestrator internals.

**Answer**: *Pending*

### Q5: FR-107 log line — event name, level, and fields
**Context**: FR-107 requires a structured log line on marker-based exclusion with `commentId`, `author`, and matched marker prefix — body never logged (SC-007 discipline). It does not pin the event name, log level, or additional fields. Two implementers would produce two different observability shapes, which matters for downstream operator tooling that greps or JSON-decodes these lines.
**Question**: What is the concrete log line shape for FR-107?
**Options**:
- A: `logger.info({ event: 'clarification-answer-scanner-marker-excluded', commentId, author, markerPrefix, issueNumber }, 'Excluded from answer-scanner via question marker')`. Info level; long-form event name matching existing surface conventions.
- B: Same shape at `debug` level. Excluded comments are expected during every clarify cycle; info would flood logs on healthy repos.
- C: Bare-minimum — fields from the spec only (`commentId`, `author`, `markerPrefix`), event name/level left to the implementer, no additional context. Downstream tooling greps the message string.

**Answer**: *Pending*
