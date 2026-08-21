# Feature Specification: Collapse the triple findings-artifact schema; activate or delete the discarded convergence engine

**Branch**: `1161-severity-major-p1-review` | **Date**: 2026-08-21 | **Status**: Draft

## Summary

**Severity: major (P1).** The engine-native review subsystem (epic #1120) shipped
three parallel findings-artifact schemas, two `computeVerdict` implementations,
three severity-rank tables, and a fully-built convergence engine whose output is
computed and then thrown away. The **live** review path implements none of the
epic's round-over-round convergence invariants: every round re-runs a full
whole-PR review from scratch, the agent rewrites the sidecar wholesale, and a
finding the round-2 agent forgets to re-emit silently vanishes and flips the
verdict to `clean`. This is the change that was supposed to cut the review↔remediate
loop from 3–6 rounds down to convergence.

Concrete debt found in the tree (line refs drift from the issue's `155b3464` base):

- **Triple schema — one live, two orphaned:**
  - `packages/orchestrator/src/worker/review-artifact.ts` — **LIVE**. Severities
    `critical|major|minor`, status `open|resolved`, no per-finding id, verdict
    recomputed by the engine per FR-007. Owns its own `SEVERITY_RANK` + `computeVerdict`.
  - `packages/orchestrator/src/worker/review-findings-artifact.ts` — **#1125,
    effectively dead**. Severities `blocking|advisory`, marker-keyed, header comment
    states the verdict is "never re-derived [Q5→A]" — directly contradicts the live
    schema's FR-007 recompute. Its own comment flags itself as a temporary local
    copy to be deleted.
  - `packages/orchestrator/src/worker/review/findings-artifact.ts` — **#1126
    scaffolding**. Id-keyed, `round`-0 semantics, `lastReviewedSha`, its own
    `SEVERITY_ORDER` + `sev()`. Consumed only by the discarded convergence engine.
- **Duplicated verdict/severity logic:** two `computeVerdict` (review-artifact.ts,
  review/findings-advance.ts) and three severity-rank tables
  (review-artifact.ts `SEVERITY_RANK`, review/findings-artifact.ts `SEVERITY_ORDER`,
  remediate-executor.ts `SEVERITY_RANK`).
- **Discarded convergence engine:** `PhaseLoop.runReviewConvergence` runs real work
  on every review entry (`readPauseContext`, `resolveBaseRef`, `computeReviewDelta`),
  calls `buildVerificationPrompt(...)` and then **throws the prompt away**;
  `advanceArtifact` is invoked with empty `reviewerAddressed` / `reviewerNewFindings`.
  It persists a round counter to a `review-findings:<owner>:<repo>:<issue>:<branch>`
  PhaseTracker key that nothing else reads, which drifts from the sidecar `round`
  (it advances even when the CLI review fails). It resolves `blockingSeverity` via
  `resolveWorkflowOverrides(config, null, workflowName)` — **`settings = null`** —
  while the executor and gate resolve with real `deps.settings`, so any per-workflow
  `blockingSeverity` override produces two different verdicts for the same PR.
- **Live-path convergence invariants unimplemented:** the round ≥ 2 charter
  (`review-charter.ts`) is byte-identical to round 1 except the number. No
  delta-since-`lastReviewedCommitSha` scoping (the field is write-only across the
  codebase), no enumeration of still-open findings, no "new findings only at
  blocking severity on re-review" rule. `advanceArtifact.filterNewFindings` already
  encodes exactly these round ≥ 2 rules — but it is only reachable from the dead
  engine.
- **Default drift:** `DEFAULT_REVIEW.blockingSeverity = 'critical'` for **all**
  workflows (`worker/config.ts`); the epic design intended `speckit-feature = major`.
  Docs (`docs/docs/reference/review-artifacts.md`) currently describe `critical`.
  The default and the docs must be reconciled to one decision.

**Fix direction:** collapse to a single findings-artifact schema, a single verdict
function, and a single severity-rank table; **either** wire the #1126
delta/verification convergence path end-to-end into the live charter + engine-side
monotonic status transitions **or** delete the scaffolding wholesale; fix the
`settings = null` call so every consumer resolves `blockingSeverity` identically.

---
Filed from a post-merge code review of epic generacy-ai/generacy#1120. Part of
follow-up epic generacy-ai/generacy#1153. All original line refs at develop `155b3464`.

## User Stories

### US1: Trustworthy round-over-round review convergence (Primary)

**As an** operator relying on the engine-native review phase,
**I want** each re-review round to be scoped to what changed since the last review
and to preserve findings the agent already raised,
**So that** a real defect cannot silently vanish when the round-2 agent forgets to
re-emit it, and the loop converges in a bounded number of rounds instead of
re-litigating the whole PR each time.

**Acceptance Criteria**:
- [ ] A finding raised in round 1 and left unaddressed is still `open` after round 2
      without the agent having to re-emit it; the verdict stays `changes-required`.
- [ ] On round ≥ 2 the review is scoped to the delta since `lastReviewedCommitSha`
      (D1 = activate: `lastReviewedCommitSha` is read by the delta-scoping logic).
- [ ] A resolved finding is never silently reopened; status transitions are monotonic
      and engine-owned.

### US2: One schema, one verdict, one severity table

**As a** maintainer of the orchestrator worker,
**I want** exactly one findings-artifact schema, one `computeVerdict`, and one
severity-rank table,
**So that** there is a single source of truth for what "blocking" means and no
possibility of two code paths disagreeing about the same PR's verdict.

**Acceptance Criteria**:
- [ ] Exactly one findings-artifact schema type remains under
      `packages/orchestrator/src/worker/`; the orphaned copies are deleted.
- [ ] Exactly one `computeVerdict` and one severity-rank table remain; all consumers
      (review executor, remediate executor, gate, convergence) import them.
- [ ] `tsc` / lint pass with no unused-export or dead-file warnings for the removed
      schemas.

### US3: Consistent `blockingSeverity` resolution

**As an** operator who sets a per-workflow `blockingSeverity` override,
**I want** every consumer of the verdict to resolve the same effective severity,
**So that** the review executor, remediate executor, gate, and any convergence step
agree on `clean` vs `changes-required` for a given PR.

**Acceptance Criteria**:
- [ ] No verdict-relevant call site resolves `blockingSeverity` with `settings = null`
      while another resolves it with real settings.
- [ ] With a per-workflow `blockingSeverity` override set, all consumers produce an
      identical verdict for the same findings set (covered by test).

### US4: Reconciled default and documentation

**As a** maintainer,
**I want** the built-in `blockingSeverity` default and the reference docs to agree,
**So that** operators are not misled about when a review blocks.

**Acceptance Criteria**:
- [ ] `DEFAULT_REVIEW.blockingSeverity` and `docs/docs/reference/review-artifacts.md`
      state the same value for each workflow.
- [ ] The decision (feature = `major` vs `critical`) is recorded with rationale.

## Resolved Decisions (via `/speckit:clarify`, 2026-08-21)

- **D1 — Activate the #1126 convergence engine.** Wire its delta-scoping
  (round ≥ 2 scoped to `lastReviewedCommitSha`), still-open-finding enumeration,
  blocking-severity-only new findings, and engine-side monotonic status transitions
  into the live review charter + executor end-to-end. The engine is fully
  built/unit-tested but disconnected (`runReviewConvergence` calls `advanceArtifact`
  with empty inputs and discards the verification prompt) — unfinished #1127-bridge
  wiring, not a deliberate stateless choice. This is the mechanism that meets the
  churn-reduction goal.
- **D2 — Canonical schema shape.** Severity vocabulary is `critical|major|minor` (the
  live `review-artifact.ts` vocabulary, shared by both surviving schemas). The single
  canonical schema is **convergence-capable**: a stable per-finding id, engine-owned
  monotonic `open|resolved` status, `lastReviewedCommitSha`, and `round`. This is the
  superset the convergence engine keys on (`advanceArtifact` matches findings by id
  within the delta and enforces resolved-is-terminal). Back-compat parsing
  default-fills the new fields on in-flight sidecars written by the shipped code.
- **D3 — `speckit-feature` default `blockingSeverity` = `major`.** Restore the epic's
  intended default; update both the code constant (`DEFAULT_REVIEW.blockingSeverity`)
  and `docs/docs/reference/review-artifacts.md` to `major`. Bugfix/other workflows
  unchanged unless separately specified. `major` is only meaningful under the
  `critical|major|minor` vocabulary (D2).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Collapse to exactly one findings-artifact schema under `worker/`; delete the two orphaned copies (`review-findings-artifact.ts`, `review/findings-artifact.ts`) or fold their surviving fields into the canonical one. | P1 | Depends on D1/D2 |
| FR-002 | Collapse to exactly one `computeVerdict` implementation, imported by all consumers. | P1 | |
| FR-003 | Collapse to exactly one severity-rank table, imported by review executor, remediate executor, and any convergence step. | P1 | |
| FR-004 | Every verdict-relevant consumer resolves `blockingSeverity` through the same code path with the same `settings`; remove the `settings = null` resolution in the convergence/review-loop path. | P1 | |
| FR-005 | Activate the delta/verification convergence path end-to-end (D1): the live charter scopes round ≥ 2 to the delta, enumerates still-open findings, restricts new findings to blocking severity, and applies engine-side monotonic status transitions. No half-wired middle state may remain (no computed-then-discarded verification prompt, no `advanceArtifact` call with empty inputs). | P1 | D1 = activate |
| FR-006 | Eliminate the drifting round counter: the sidecar `round` is the single source of round truth; no separate PhaseTracker round key that advances independently (and advances even when the CLI review fails). Round advances only on a successful review. | P1 | D1 = activate |
| FR-007 | `lastReviewedCommitSha` must be read by the delta-scoping logic; no write-only fields left dangling. | P1 | D1 = activate |
| FR-008 | Reconcile `DEFAULT_REVIEW.blockingSeverity` and `docs/docs/reference/review-artifacts.md` to the D3 decision. | P1 | |
| FR-009 | Preserve existing behavior for callers not touched by the collapse: PR review posting/lifecycle (#1156), remediate executor cap (#1128), resume-gate handling (#1154) continue to pass their tests. | P1 | Regression guard |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Distinct findings-artifact schema types under `worker/` | 1 | grep/type audit after change |
| SC-002 | Distinct `computeVerdict` implementations | 1 | grep audit |
| SC-003 | Distinct severity-rank tables | 1 | grep audit |
| SC-004 | Verdict-relevant call sites resolving `blockingSeverity` with `settings = null` | 0 | grep audit + test asserting override parity |
| SC-005 | Findings that silently vanish across rounds (raised-then-forgotten) | 0 | convergence test: round-2 agent omits a round-1 finding → still `open` (D1=activate) |
| SC-006 | Round counters that can disagree for one review | 0 | single-source-of-round test |
| SC-007 | Docs vs code default `blockingSeverity` mismatch | 0 | assertion/test comparing constant to doc |
| SC-008 | Pre-existing review/remediate/lifecycle test suites | all green | `pnpm --filter @generacy-ai/orchestrator test` |

## Assumptions

- The whole feature stays behind the existing epic feature flag(s)
  (`reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED`); a flag-OFF cluster is
  byte-identical before and after.
- No cloud-side or cluster-base change is required — this is orchestrator-internal
  consolidation.
- The canonical schema, once chosen, back-compat-parses any sidecar written by the
  shipped code (default-valued new/removed fields) so an in-flight PR mid-loop does
  not wedge on redeploy.

## Out of Scope

- Redesigning the review/remediate phase protocol, gate labels, or the pause/resume
  contract (owned by #1154 and the epic).
- PR review comment wording or cockpit gate-answer wording (agency repo).
- Changing the remediate cap semantics (#1128) or CI merge-gate (#1133) beyond
  importing the single shared severity table.
- Adding new review capabilities beyond what the epic already shipped.

---

*Generated by speckit*
