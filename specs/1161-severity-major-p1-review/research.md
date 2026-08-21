# Research: Collapse the triple findings-artifact schema; activate the discarded convergence engine

**Feature**: `1161-severity-major-p1-review` | **Date**: 2026-08-21

This document records the technology decisions behind the plan, the alternatives
considered, and the reconciliation work the collapse forces. Every decision maps
to a resolved clarification (D1–D3, Q1–Q4) or to a codebase fact discovered while
inventorying the three schemas.

---

## Decision 1 — Activate the convergence engine (D1 / Q1=A)

**Decision**: Wire the #1126 convergence path (`computeReviewDelta` →
`composeVerificationInput` → `buildVerificationPrompt` → `advanceArtifact`) into
the live `review-executor.ts`, replacing the discarded `PhaseLoop.runReviewConvergence`
pre-pass.

**Rationale**: The engine is fully built and unit-tested but disconnected. Today
`runReviewConvergence` (`phase-loop.ts:1977-2047`) does real work every review entry
(`readPauseContext`, `resolveBaseRef`, `computeReviewDelta`), calls
`buildVerificationPrompt(...)` and **throws the prompt away** (`:2016-2020`), then
calls `advanceArtifact` with **empty** `reviewerAddressed` / `reviewerNewFindings`
(`:2028-2034`). It is unfinished #1127-bridge wiring, not a deliberate stateless
choice. Delta-scoped convergence is the mechanism for the epic's churn-reduction
goal (3–6 rounds → convergence) and the anti-vanish invariant (SC-005).

**Alternatives considered**:
- **Delete the scaffolding (Q1=B)** — keep a stateless whole-PR review each round.
  Rejected: the epic's central promise (bounded convergence, no silently-vanishing
  findings) would be abandoned, and the acceptance criteria (US1) would have to be
  re-scoped to documented whole-PR semantics. The groundwork is already shipped;
  deleting it discards working, tested code to preserve a bug.
- **Keep `runReviewConvergence` as a pre-pass and feed it real inputs** — Rejected:
  it persists a round counter to a `review-findings:<owner>:<repo>:<issue>:<branch>`
  PhaseTracker key that nothing else reads and that advances even when the CLI
  review fails (FR-006 violation), and it resolves `blockingSeverity` with
  `settings = null` (FR-004 violation). The pre-pass architecture is the source of
  both drift bugs; folding the merge into the executor eliminates them by
  construction.

**Consequence**: The sidecar `round` becomes the single source of round truth
(FR-006); the PhaseTracker round key is deleted. `lastReviewedCommitSha` is read by
the delta-scoping logic (FR-007) instead of being write-only.

---

## Decision 2 — Canonical schema home = `review-artifact.ts` (D2)

**Decision**: The one surviving findings-artifact schema is the **LIVE**
`worker/review-artifact.ts`. It gains a stable per-finding `id`. The two orphan
schemas (`worker/review-findings-artifact.ts` #1125, `worker/review/findings-artifact.ts`
#1126) are deleted.

**Rationale**: `review-artifact.ts` already has the most consumers, owns the
persistence helpers (`writeReviewArtifact`, `readReviewArtifact`,
`bumpRemediationCount`, `setMarkedReadyByEngine`), and carries the fields #1128/#1156
depend on (`remediationCount`, `markedReadyByEngine`). It already owns the single
`SEVERITY_RANK` and the single `computeVerdict` that the epic's verdict recompute
(FR-007) runs through. Moving the canonical home anywhere else would strand those
consumers.

**Severity vocabulary (Q3=A)**: `critical | major | minor`. Shared by BOTH surviving
schemas (live sidecar + #1126 convergence seam). The #1125 `blocking | advisory`
vocabulary exists only in `review-findings-artifact.ts`, which is self-documented as
a temporary copy to delete. `major` (the D3 default) is only meaningful under a graded
scale, so `critical | major | minor` is the only vocabulary consistent with D3.

**Field set (Q4=A) — convergence-capable**: stable per-finding `id`, engine-owned
monotonic `open | resolved` status, `lastReviewedCommitSha`, and `round`. This is the
superset the convergence engine keys on: `advanceArtifact` matches findings by `id`
within the delta (`findings-advance.ts:89-99`) and enforces resolved-is-terminal.
The live schema already has `status`, `round`, `lastReviewedCommitSha`; only `id` is
new.

**Alternatives considered**:
- **Minimal field set (Q4=B)** — keep the live shape with no per-finding id.
  Rejected: only valid under Q1=delete. Cross-round matching needs a stable identity.
- **Collapse onto #1125's `blocking | advisory` (Q3=B)** — Rejected: would re-express
  `blockingSeverity` as a boolean split and adopt the doomed copy's vocabulary.

---

## Decision 3 — `speckit-feature` default `blockingSeverity = major` (D3 / Q2=A)

**Decision**: Replace the flat `DEFAULT_REVIEW.blockingSeverity = 'critical'` with a
per-workflow default: `speckit-feature → major`, all other workflows → `critical`.
Update `docs/docs/reference/review-artifacts.md` to match.

**Rationale**: The epic design intended `speckit-feature = major`; the shipped code
regressed to a flat `critical`. FR-008/SC-007 require the constant and the docs to
agree. Under the activation posture (D1) restoring the epic-intended default is the
consistent choice, and `major` is only meaningful under the `critical | major | minor`
vocabulary (D2).

**Implementation pattern**: Mirror the existing `defaultMaxRemediations` per-workflow
default in `config.ts` (`speckit-bugfix → 2`, else `→ 3`). A parallel
`defaultBlockingSeverity(workflowName)` returning `speckit-feature → 'major'`, else
`'critical'`, consumed by `resolveWorkflowOverrides` as the fallback when no explicit
`review.blockingSeverity` override is set.

**Alternatives considered**:
- **Keep `critical` (Q2=B)** — Rejected: contradicts the epic design; the clarification
  chose to restore the intended default rather than ratify the regression.

---

## Decision 4 — Field-name reconciliation: `lastReviewedCommitSha` vs `lastReviewedSha`

**Problem**: The canonical schema names the field `lastReviewedCommitSha`; the #1126
convergence code (`review/review-delta.ts`, `review/findings-artifact.ts`) reads
`artifact.lastReviewedSha`.

**Decision**: Canonical name wins — `lastReviewedCommitSha`. Retarget
`computeReviewDelta` and any other convergence reader to the canonical field. The
#1126 name disappears with its schema file.

**Rationale**: The canonical home is `review-artifact.ts` (Decision 2); its field name
is authoritative. Renaming the reader is a mechanical retarget confined to the
convergence files being retargeted anyway.

---

## Decision 5 — Round-base reconciliation: 1-based live vs 0-based #1126

**Problem**: The live `review-artifact.ts` uses `round: z.number().int().positive()`
(1-based, first review is round 1). The #1126 `findings-artifact.ts` uses `round`-0
semantics (first review is round 0).

**Decision**: Canonical 1-based rounds win. The executor writes
`round = prior.round + 1` on each successful review, first review = round 1. Retarget
`computeReviewDelta` (which currently computes `round = artifact.round + 1`) and
`filterNewFindings` (which gates "new findings only at blocking severity on round >= 2")
to the 1-based convention — semantically identical since both compare against a
constant threshold of 2.

**Rationale**: The 1-based convention is already the live, persisted shape (#1124/#1128
sidecars in flight carry it). Changing the persisted base would wedge in-flight PRs.
The #1126 0-based semantics were never persisted (dead engine), so there is nothing to
preserve.

---

## Decision 6 — Back-compat parsing for the new `id` field

**Problem**: In-flight sidecars written by the shipped code lack per-finding `id`.
A redeploy mid-loop must not wedge a PR.

**Decision**: On parse, default-fill `id` for any finding that lacks it, derived
deterministically as `sha256(file + '\0' + title).slice(0, 24)` (hex, 24 chars = 96
bits). Apply the fill inside `readReviewArtifact` / `readReviewArtifactSync` /
`readCandidateFindings` before the artifact reaches any consumer.

**Rationale**:
- The `file + '\0' + title` key is stable across `line` / `detail` drift, so a
  round-1 finding re-emitted in round 2 with a moved line still derives the same `id`
  and matches in the delta.
- The `\0` separator prevents concatenation collisions (`("ab","c")` vs `("a","bc")`).
- 24 hex chars matches the codebase's existing `gate-id` derivation convention.
- This exact derivation already exists in `review-findings-bridge.ts`
  (`synthesizeMarker`, being deleted); the logic is proven and moves into the canonical
  parse path.
- `readReviewArtifact` returns the canonical shape or `null` and never throws to the
  caller, so a malformed sidecar degrades to a fresh review rather than a crash.

**Alternatives considered**:
- **Require `id` and reject sidecars without it** — Rejected: wedges every in-flight
  PR on redeploy (violates the Assumptions back-compat requirement).
- **Random UUID fill** — Rejected: a random id changes every parse, so cross-round
  matching would break for exactly the in-flight sidecars back-compat is meant to
  protect. The derivation must be deterministic.

---

## Decision 7 — Executor-side convergence merge (replaces `runReviewConvergence`)

**Decision**: In `review-executor.ts`, after the CLI produces a candidate findings
set, run the real merge:

1. Read the prior sidecar (`readReviewArtifact`) → `prior` (or `null` on round 1).
2. `computeReviewDelta(prior, HEAD, ...)` from `prior.lastReviewedCommitSha`.
3. Build a **delta-scoped** charter (round >= 2, verification profile) that enumerates
   still-open findings — feeding `buildVerificationPrompt` output into the live charter
   instead of discarding it.
4. Spawn the CLI, read the candidate findings.
5. `advanceArtifact(prior, delta, reviewerAddressed, reviewerNewFindings)` with **real**
   inputs — carry forward unaddressed open findings (anti-vanish), resolve addressed
   ones (monotonic), admit new findings only at blocking severity on round >= 2.
6. `computeVerdict(mergedFindings, blockingSeverity)` — the single engine verdict.
7. Write the canonical sidecar with `round = prior.round + 1`,
   `lastReviewedCommitSha = HEAD`, preserving `remediationCount` / `markedReadyByEngine`.

Round advances **only** on a successful review; the sidecar is the single round source.

**Rationale**: Folding the merge into the executor (where the CLI candidate, the prior
sidecar, and the resolved `this.settings` all already exist) eliminates the two drift
bugs the pre-pass architecture created — the independent PhaseTracker round key
(FR-006) and the `settings = null` verdict resolution (FR-004). The executor already
resolves `blockingSeverity` via `resolveWorkflowOverrides(this.config, this.settings,
workflowName)`, so every verdict-relevant call site now agrees (US3 / SC-004).

**`blockingSeverity` consistency (FR-004)**: The deleted `runReviewConvergence` was the
sole `settings = null` resolver. Once it is gone, the executor, the gate, and the
convergence merge all resolve through `resolveWorkflowOverrides(config, this.settings,
workflowName)`. SC-004 (zero `settings = null` call sites) is satisfied by deletion.

---

## Decision 8 — Poster consumes canonical `ReviewFinding[]`

**Decision**: `review-poster.ts` consumes the canonical `ReviewFinding[]` directly
instead of the #1125 `FindingsArtifact`. Rendering:
- `marker = finding.id`
- `text = finding.title + '\n\n' + finding.detail`
- blocking vs advisory is a **render-time projection**:
  `SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[blockingSeverity]`.

**Rationale**: This deletes the `review-findings-bridge.ts` intermediary entirely — the
poster no longer needs a translated artifact. All #1156 posting/lifecycle behavior is
preserved byte-for-byte (FR-009); only the input **type** changes. The blocking/advisory
distinction was never a stored field on the canonical schema; deriving it at render keeps
`SEVERITY_RANK` as the single severity table (FR-003 / SC-003).

**Consequence**: `#1156` poster tests update only for the input type. The
`review-findings-bridge.ts` file and its `bridgeReviewArtifact` / `synthesizeMarker`
helpers are deleted; the `synthesizeMarker` derivation survives as the back-compat
`id` fill (Decision 6).

---

## Decision 9 — Collapse the duplicate `computeVerdict` and severity tables

**Decision**: Delete the second `computeVerdict` (`review/findings-advance.ts:58-67`)
and the two extra severity tables (`review/findings-artifact.ts` `SEVERITY_ORDER`,
`remediate-executor.ts` local `SEVERITY_RANK`). All consumers import the canonical
`computeVerdict` and `SEVERITY_RANK` from `review-artifact.ts`.

**Rationale**: FR-002/FR-003/SC-002/SC-003 require exactly one of each. `SEVERITY_ORDER`
(`minor:0, major:1, critical:2`) and `SEVERITY_RANK` (`critical:3, major:2, minor:1`)
are the same ordering expressed differently; the canonical `SEVERITY_RANK` (higher =
more severe) is kept because `computeVerdict` and the poster projection already use it.

---

## Cross-cutting: flag-OFF byte-identity

All changes sit inside the `review` phase path, unreachable when
`reviewPhaseEnabled = false` (default; env `WORKER_REVIEW_PHASE_ENABLED`). A flag-OFF
cluster is byte-identical before and after (Assumptions / SC-008 regression guard). The
`speckit-feature` default change (D3) only takes effect when the review phase runs.

---

## Sources

- `specs/1161-severity-major-p1-review/spec.md` — FR-001..FR-009, SC-001..SC-008, US1..US4.
- `specs/1161-severity-major-p1-review/clarifications.md` — Q1=A, Q2=A, Q3=A, Q4=A.
- `packages/orchestrator/src/worker/review-artifact.ts` — canonical schema, `SEVERITY_RANK`, `computeVerdict`, persistence helpers.
- `packages/orchestrator/src/worker/review/findings-advance.ts` — `advanceArtifact`, `filterNewFindings`, duplicate `computeVerdict`.
- `packages/orchestrator/src/worker/review/review-delta.ts` — `computeReviewDelta`, `lastReviewedSha` reader.
- `packages/orchestrator/src/worker/phase-loop.ts` — `runReviewConvergence`, PhaseTracker round key, `settings = null` resolution.
- `packages/orchestrator/src/worker/review-poster.ts` — #1156 posting/lifecycle.
- `packages/orchestrator/src/worker/config.ts` — `DEFAULT_REVIEW`, `resolveWorkflowOverrides`, `defaultMaxRemediations` pattern.
- `docs/docs/reference/review-artifacts.md` — default `blockingSeverity`, severity vocabulary.
