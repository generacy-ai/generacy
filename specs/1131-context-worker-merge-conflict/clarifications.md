# Clarifications

## Batch 2026-08-20

### Q1: Scoped-review diff-window mechanism
**Context**: FR-002 requires the scoped review's diff window to be the merge commit vs. the pre-merge branch tip. The epic's review executor as it exists today (`review-executor.ts` + `review-charter.ts`) has **no** base..head diff-window parameter — the charter tells the agent to review "the PR diff (the commits on this branch relative to its base)", i.e. the whole branch. Bounding the review to just the resolution diff needs a concrete mechanism.
**Question**: How does the scoped review bound its input diff to base..head?
**Options**:
- A: Extend the review executor/charter with an explicit `base..head` diff-window input (new parameter), threaded from the resolution SHAs, so the charter names the exact range the agent must review.
- B: Reuse the existing `phase-start-ref` anchoring — the handler pre-seeds the `review` phase's `phase-start-ref` key with the resolution base SHA, and the existing diff-window machinery scopes it without changing the executor.
- C: The review executor reviews the whole PR diff unchanged; the base/head SHAs are advisory context only (accepts that unrelated branch files may appear in the review).

**Answer**: *Pending*

### Q2: Base/head SHA transport to the review phase
**Context**: FR-006 stores the resolution base/head SHAs in the merge-conflict pause-context sidecar (`ResolveMergeConflictsMetadata`). But the `re-armed` `HandlerOutcome` carries only `startPhase: WorkflowPhase`, and the review executor does not read `ResolveMergeConflictsMetadata`. There must be a defined path from handler success → the value the scoped review consumes on entry.
**Question**: Through what channel do the resolution base/head SHAs reach the review executor?
**Options**:
- A: The handler writes a dedicated review-scope entry to the workflow state store (or `phaseTracker`) keyed by owner/repo/issue/branch; the review executor reads it on entry.
- B: Extend the `re-armed` outcome (and the dispatcher enqueue → `WorkerContext`) to carry the SHAs alongside `startPhase`.
- C: The sidecar (`ResolveMergeConflictsMetadata`) is the single source of truth and the review executor is taught to read it directly.

**Answer**: *Pending*

### Q3: Interaction with the `reviewPhaseEnabled` feature flag
**Context**: `review` is feature-flagged OFF by default (`config.reviewPhaseEnabled`, from #1121/#1124). When the flag is off, `phase-loop.ts:269-271` filters `review` out of the effective sequence, and `sequence.indexOf(context.startPhase)` at `:302-305` **throws `Unknown starting phase: review`** for a `startPhase: 'review'` re-arm. So re-arming into `review` while the flag is off is currently a hard crash, not a skip.
**Question**: How should the merge-conflict re-arm behave with respect to `reviewPhaseEnabled`?
**Options**:
- A: The merge-conflict resolution path forces the scoped review ON regardless of the global `reviewPhaseEnabled` flag (the safety invariant FR-005 always applies to resolutions).
- B: The scoped-review re-arm is itself gated by `reviewPhaseEnabled`; when the flag is off, the handler falls back to today's `startPhase: metadata.phase` re-arm.
- C: This feature ships only in tandem with `reviewPhaseEnabled` defaulting ON; the flag-off case is not a supported configuration for merge-conflict resolution.

**Answer**: *Pending*

### Q4: Disposition when resolution SHAs are unavailable
**Context**: `finishSuccess` currently fails loud (`blocked:stuck-merge-conflicts`) if `metadata.phase` is missing (`merge-conflict-handler.ts:641-656`), never re-deriving from labels. FR-006 adds required base/head SHAs. The Assumptions section says both SHAs are always known at handler success time — but the missing-value disposition must still be defined, and it's unclear whether `metadata.phase` remains a hard requirement now that re-arm no longer targets it.
**Question**: If the resolution base and/or head SHA cannot be determined at success time, what disposition applies — and is `metadata.phase` still required?
**Options**:
- A: Missing base/head SHA → fail-loud with `blocked:stuck-merge-conflicts` (same as missing `phase` today); `metadata.phase` is no longer required for the re-arm since it targets `review`.
- B: Missing base/head SHA → fall back to today's `startPhase: metadata.phase` re-arm (no fail-loud); `metadata.phase` stays required as the fallback target.
- C: Missing base/head SHA → re-arm `review` anyway with a whole-branch diff fallback; keep `metadata.phase` required for the fail-loud guard.

**Answer**: *Pending*

### Q5: Empty or trivial resolution diff
**Context**: The review charter (`review-charter.ts:52-61`) instructs the agent to record an empty/trivial diff as a `blockingSeverity`-or-higher finding ("an empty diff means the implementation did not happen"). A merge-conflict resolution can legitimately produce an empty or trivial resolution diff (e.g. an "ours"/"theirs" pick that reintroduces no net change). Under the unchanged charter, such a resolution would wrongly surface a blocking finding and enter the `remediate` loop instead of proceeding to `validate`.
**Question**: How should the scoped review treat a legitimately empty or trivial resolution diff?
**Options**:
- A: The engine short-circuits: if the resolution diff window is empty, skip the review executor and proceed directly to `validate` (still satisfies FR-005).
- B: Run the scoped review but suppress the charter's "empty diff = blocking finding" rule for the resolution-scoped case (empty is expected, not a defect).
- C: Treat it like any other review — an empty resolution diff produces a blocking finding and enters `remediate` (accept that operators must clear it).

**Answer**: *Pending*
