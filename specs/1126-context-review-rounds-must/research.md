# Research: delta-scoped verification passes (#1126)

## Decision 1 — Where the convergence logic lives

**Decision**: A new pure-function module `packages/orchestrator/src/worker/review/`,
consumed from the existing `review` stub branch in `phase-loop.ts:473-477`.

**Rationale**: The `review`/`remediate` phase machinery, the `remediateTrigger`
seam, and `runStubPhase` already live in `packages/orchestrator/src/worker/`
(added by #1121). Placing the convergence logic beside them keeps the phase loop
the single orchestration point and avoids a new cross-package edge. The git-diff
primitives it needs are already on `GitHubClient` (`context.github`), so no
`@generacy-ai/workflow-engine` change is required.

**Alternatives considered**:
- *In `@generacy-ai/workflow-engine`*: rejected — the artifact, pause-context, and
  PhaseTracker persistence are all orchestrator concerns; the logic would need to
  reach back into orchestrator types.
- *Inline in `phase-loop.ts`*: rejected — the FR logic must be unit-testable in
  isolation (SC-001…SC-006) without booting the phase loop.

## Decision 2 — Reading an artifact that #1124 owns

**Decision**: Define a minimal structural interface (`FindingsArtifact`,
`ReviewFinding`) in `review/findings-artifact.ts`, and write every convergence
function to take the artifact as a parameter (dependency injection). Mark the
interface `// #1124 seam`.

**Rationale**: The spec is explicit that #1124 owns the schema and this feature
"reads and advances that artifact; it does not define it." An injected structural
interface lets this feature build and its unit tests run whether or not #1124 has
merged. When #1124 lands, the placeholder is re-exported from / narrowed to #1124's
canonical type with no change to the pure functions.

**Alternatives considered**:
- *Hard-import #1124's type*: rejected — creates a build-order dependency on an
  unmerged issue.
- *`any`/untyped artifact*: rejected — loses the SC-002 transition guarantees the
  type system should enforce.

## Decision 3 — Delta computation base selection (FR-002 / FR-007 / FR-009)

**Decision**: One function `computeReviewDelta` with a strict base-selection order:

1. Pause-context resolution SHAs present ⇒ `getFilesChangedBetween(resBase, resHead)` (FR-007).
2. Else artifact last-reviewed SHA present **and** `commitExistsInCheckout(sha)` ⇒ `getFilesChangedBetween(lastReviewedSha, headSha)` (FR-002).
3. Else ⇒ full diff `getFilesChangedBetween(prBaseRef, headSha)` (FR-009 widened verification pass).

Every branch returns `{ files, round: artifactRound + 1, mode: 'verification' }`
for round ≥ 2; the caller never sees a round-1 reset from the fallback (Q5).

**Rationale**: The existing `getFilesChangedBetween(base, head)` (`gh-cli.ts:1382`)
already computes `git diff --name-only base...head` and throws loudly on a bad
revision. `commitExistsInCheckout` (already used by the `phase-start-ref` guard)
distinguishes "SHA gone after rebase" (⇒ FR-009 fallback) from a real git error
(⇒ surface). Identical SHAs yield an empty delta for free (SC-001).

**Alternatives considered**:
- *`getFilesChangedByOwnCommits(startRef)`* (`gh-cli.ts:1410`): usable for the
  own-commits window but the review delta is base…head, not first-parent own
  commits; `getFilesChangedBetween` is the correct primitive.
- *Catch-all `try/catch` widening on any error*: rejected — would swallow genuine
  git failures. Use `commitExistsInCheckout` to gate the fallback precisely
  (FR-009 says fall back for *unresolvable* SHAs, not for arbitrary errors).

## Decision 4 — Status machine (FR-006, Q1, Q2)

**Decision**: `advanceArtifact` implements a monotonic machine:
- `open` finding whose `file` (and `line` if present) is in the delta **and** the
  reviewer reports it addressed ⇒ `resolved`.
- `open` finding not in the delta ⇒ stays `open` (Q2 — evidence-based).
- `resolved` ⇒ never mutated (Q1 — terminal). A re-break at a resolved location is
  appended as a **new** finding via the new-finding path, subject to filter.
- New findings appended with `round = currentRound`, after `filterNewFindings`.
- `lastReviewedSha` set to the head just reviewed.

**Rationale**: Monotonic terminal `resolved` guarantees convergence — the open set
only shrinks or gains genuinely-new blocking findings, so the loop cannot oscillate.

## Decision 5 — Engine-side advisory filter (FR-005, Q3)

**Decision**: `filterNewFindings(newFindings, round, blockingSeverity)` drops any
finding below `blockingSeverity` when `round >= 2`, before it reaches
`advanceArtifact`. Round 1 keeps advisory findings (unchanged full-review behavior).

**Rationale**: The engine is authoritative and distrustful of agent-claimed output
(Q3=A). A deterministic drop is robust where prompt adherence is not. Severity
ordering is `minor < major < critical`; "sub-blocking" = strictly below the
configured `blockingSeverity`.

**Alternatives considered**: prompt-only (Q3=B — lighter but relies on the exact
nondeterminism this feature removes); downgrade-to-advisory (Q3=C — a no-op that
still posts churn).

## Decision 6 — Verdict (FR-008)

**Decision**: `computeVerdict(artifact, blockingSeverity)` returns
`changes-required` iff any finding with `severity >= blockingSeverity` has
`status === 'open'`; else `clean`. Computed over the post-advance artifact so a
newly-raised blocking finding and a still-open prior blocking finding both gate.

**Rationale**: Reuses #1124's severity gating over the artifact; no separate verdict
state to keep in sync.

## Decision 7 — Persistence

**Decision**: Persist the artifact + `lastReviewedSha` via
`PhaseTracker.getValueRaw/setValueRaw/clearRaw` under
`review-findings:<owner>:<repo>:<issue>:<branch>` with the same 7-day TTL as
`phase-start-ref:` (`phase-loop.ts:389-398`).

**Rationale**: Reuses a proven Redis-backed sidecar seam that already degrades to
null/no-op when Redis is down (so a missing store falls through to a fresh full
review — the FR-009 posture). When #1124 introduces its own persistence, this key
becomes the read-through source or is superseded; the pure functions are
storage-agnostic either way.

## Open reconciliation — `blockingSeverity` default

`spec.md` Assumptions claim a feature default of `major`, but `config.ts:11`
`DEFAULT_REVIEW.blockingSeverity` is `critical` today. This feature **consumes**
`ResolvedWorkflowConfig.review.blockingSeverity`; it does not set the default. The
default is owned by #1122/#1124. **Action**: reconcile the default where it is set,
not in #1126. Recorded here so the discrepancy is not silently absorbed.

## Sources

- `packages/orchestrator/src/worker/phase-loop.ts` — review stub (473-477),
  `runStubPhase` (1183), `remediateTrigger` seam (1154-1166), `phase-start-ref`
  persistence (389-468), `reviewPhaseEnabled` filter (226-228).
- `packages/orchestrator/src/worker/types.ts` — `WorkflowPhase` (9),
  `PHASE_SEQUENCE` (58-60), `PHASE_TO_STAGE` (100-109), `PhaseLoopDeps` (62-108),
  `WorkerContext` (470-507).
- `packages/orchestrator/src/worker/pause-context.ts` — `PauseContextSchema`
  (39-45).
- `packages/orchestrator/src/worker/config.ts` — `DEFAULT_REVIEW` (11-15),
  `ResolvedWorkflowConfig.review` (33-37), `resolveWorkflowOverrides` (54-73).
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts` —
  `getFilesChangedBetween` (1382), `getCurrentCommitSha` (1396),
  `getFilesChangedByOwnCommits` (1410).
- `packages/orchestrator/src/types/monitor.ts` — `PhaseTracker` (541-569).
