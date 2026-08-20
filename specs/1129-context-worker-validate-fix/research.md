# Research: Route validate failures into the remediate loop

## Decision 1 — Entry mechanism: synthesize artifact + backtrack (not inline driver)

**Decision**: On a routed validate red, synthesize/advance the **filesystem**
review-findings artifact to `verdict: 'changes-required'` and backtrack `i` to the
`review` phase; the existing `remediateTrigger` seam (`phase-loop.ts:1270`) picks
it up naturally. (Clarification Q1→B, FR-001.)

**Rationale**: Reuses the single remediate seam and the artifact-round counter the
`on-remediation-limit` gate (#1128) already reads. An inline off-sequence
`remediate` driver (Q1→A) would be invisible to that gate, splitting the counter.

**Alternatives rejected**:
- *Inline driver (Q1→A)*: two code paths, counter split.
- *`WorkerContext.pendingValidateRemediation` flag as the trigger (Q1→C)*: a flag
  cannot survive the gate pause/resume that the persisted counter requires.

## Decision 2 — Surviving the ReviewExecutor overwrite (the core tension)

**Problem**: `ReviewExecutor.execute()` (`review-executor.ts`) always rewrites the
filesystem artifact via `writeReviewArtifact` with a verdict recomputed from the
agent-written candidate findings. On the `review` re-entry after synthesis, if the
agent writes no blocking findings, `computeVerdict([]) === 'clean'` overwrites the
synthesized `changes-required` verdict → `remediateTrigger` never fires → the thin
adapter never runs → validate loops until the fingerprint backstop, with **zero
autonomous fixing** (defeats FR-005).

**Decision**: introduce a **block-local, one-shot** control in `executeLoop`,
`pendingValidateRemediation` (holds `{ evidence, prNumber, baseBranch }`). On the
synthesis iteration:
- The `review` phase **skips** `runReviewConvergence` + `reviewExecutor.execute()`
  and returns a synthetic success (`runStubPhase('review')`-shaped result), leaving
  the synthesized artifact byte-intact for the `on-remediation-limit` gate and the
  `remediateTrigger`.
- The remediate seam consumes it: run the thin adapter (Decision 4), then clear it.
- The **second** `review` re-entry (post-fix) sees it cleared → runs the real
  delta-scoped executor (FR-003) → then `validate` re-runs.

**Why this does not violate Q1→C**: the counter stays the persisted artifact
`round`. `pendingValidateRemediation` is not the counter and is never read across a
pause/resume boundary — it lives only within one uninterrupted `for` iteration. If
the `on-remediation-limit` gate pauses on the synthesis iteration, the loop returns
and the flag is simply discarded; the persisted artifact (changes-required +
advanced round) is the authoritative state on resume.

**Alternatives rejected**:
- *Charter the review agent to preserve prior findings*: deferred to a later epic
  issue; out of scope and would couple validate routing to prompt semantics.
- *Backtrack directly to a synthetic `remediate`*: `remediate` is off-sequence
  (not in `sequence`), so `i` cannot land on it; the seam is the only entry.
- *Write the evidence as a candidate finding the executor reads*: the agent's CLI
  run overwrites the candidate file mid-`execute()`, so it would not survive.

## Decision 3 — Backtrack index

**Decision**: `i = sequence.indexOf('review') - 1; continue;` so the next `i++`
lands on `review`. Defensive against future sequence reordering; mirrors the
existing `i--; continue;` backtrack idiom at `phase-loop.ts:794` (implement) and
`:1282` (remediate seam).

## Decision 4 — Interim remediate behavior via the thin adapter

**Decision**: at the remediate seam, dispatch on `pendingValidateRemediation`:
run `validateFixHandler.handle(item, checkoutPath, { prNumber, baseBranch },
evidence, github, workflowName)` for a validate-origin remediation; otherwise
`runStubPhase('remediate')` (review-origin, unchanged). (Clarification Q2→B,
FR-005.) The handler does the real fix and carries the sibling-owned-file overlap
avoidance + revert-on-overlap guard (FR-010).

**Rationale**: `remediate` is still a stub epic-wide; fully retiring the handler
now (Q2→A) would strand every validate red at the `on-remediation-limit` pause with
no fix. One code path, guard preserved for free.

**Handler reductions** (FR-005): drop the one-attempt-per-evidence-hash live cap
(superseded by `maxRemediations`) and the base-advance gating; the handler no
longer owns escalation labels (the loop does). Keep: fix prompt from evidence,
commit, sibling-overlap enumeration + revert.

## Decision 5 — Fingerprint backstop accounting on the routed path (FR-006/FR-009)

**Constraint**: `FailureFingerprintTracker.countPriorOccurrences()`
(`services/failure-fingerprint-tracker.ts`) counts prior **failure-alert comments**
carrying the same fingerprint marker. Occurrences are recorded implicitly by
`stageCommentManager.postFailureAlert()`. `worker/failure-fingerprint.ts` semantics
and the threshold are **Out of Scope** (unchanged).

**Decision**: the routed validate branch, on each red:
1. Builds evidence, computes `fingerprint` and `occurrence = priorCount + 1`.
2. Posts a failure alert (fingerprint + occurrence marker) — this is the counting
   substrate for the next red — **without** calling `labelManager.onError('validate')`
   (so `failed:validate` is never applied, FR-009).
3. If `occurrence >= REPEAT_FAILURE_THRESHOLD` → `labelManager.onRepeatedError('validate')`
   (`failed:validate-repeated`) and return (terminal, FR-006). No routing.
4. Else → synthesize + backtrack (Decision 1/2).

**Rationale**: keeps the #942 comment-scan tracker unchanged. Identical evidence
across remediations accumulates the count; a successful fix changes the evidence →
different fingerprint → count resets — exactly US2's "reproduces identically after
remediation" semantics. Posting an alert comment is not applying a `failed:*`
label, so FR-009 holds.

**Alternative rejected**: a separate Redis fingerprint counter to avoid the alert
comment on the first (self-healing) red. Rejected: introduces a second counter and
would require changing the tracker; the alert comment is a useful audit trail and
the #942 design already depends on it.

**Accepted tradeoff**: a first-red-that-self-heals still posts one failure-alert
comment. This is diagnostic, not a human-intervention gate, and preserves the
backstop with zero tracker change.

## Decision 6 — Mutual exclusion (FR-008/SC-003)

**Decision**: **replace** the #892 block entirely. The legacy handler is invoked
at exactly one site — the remediate seam — and the direct `handle()` call in the
validate-failure branch is deleted. Mutual exclusion is structural (one call site),
not timing-based: the old path and the new loop cannot both fire for one failure.

## Decision 7 — One base-merge per cycle preserved (FR-007)

**Finding**: `hasBaseMergedThisCycle` is a **block-local** `let` re-initialized on
every `for` iteration (`phase-loop.ts:353`), including `i--; continue;` re-entries.
Each `validate` re-run is a fresh iteration = a fresh cycle, so the at-most-one
pre-phase base-merge invariant holds through the new backtrack with **no change**.

## Decision 8 — Two distinct artifacts (do not conflate)

**Finding**: the `remediateTrigger` and `on-remediation-limit` gate read the
**filesystem** sidecar (`review-artifact.ts`,
`.generacy/review-findings-<id>.json`). `runReviewConvergence` (#1126) reads a
**separate Redis** artifact
(`review-findings:<owner>:<repo>:<issue>:<branch>`). The validate synthesis writes
the **filesystem** artifact (the one the trigger/gate consume). The skip in
Decision 2 also bypasses `runReviewConvergence`, so the Redis artifact is untouched
on the synthesis iteration.

## Decision 9 — Flag-off inertness (SC-005)

With `reviewPhaseEnabled = false`, `review` is not in the effective sequence, so
the synthesis-and-backtrack target does not exist and the validate branch keeps its
current escalation. All new logic is reachable only when `review` is present.
Existing flag-off phase-loop suites pass unchanged.
