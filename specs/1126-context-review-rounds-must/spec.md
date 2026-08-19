# Feature Specification: Re-review convergence — delta-scoped verification passes

**Branch**: `1126-context-review-rounds-must` | **Date**: 2026-08-19 | **Status**: Draft

## Summary

The engine-native `review` phase (P2 of epic #1120) re-runs whenever control
backtracks from `remediate` or from a resolved merge conflict. If every re-review
re-reads the **full PR diff**, each round surfaces fresh nitpicks and the loop
never converges — exactly the 3–6-round churn seen today when `/cockpit:auto`
drives review rounds. Relocating review into the engine without convergence rules
would relocate the churn, not remove it.

This feature makes re-reviews **verification passes**: the reviewer looks only at
what changed since the last review plus the findings still open, is told the round
number, and is charter-bound not to introduce new sub-blocking findings after
round 1. Round 1 (the first review of a PR) remains a full-diff review and is
unchanged by this feature.

## Context

Review rounds must converge. A fresh full-diff review each round surfaces new
nitpicks each round — today's 3–6 review→request-changes rounds are partly review
nondeterminism, and moving review into the engine without convergence rules would
relocate the rounds, not reduce them.

Part of epic generacy-ai/generacy#1120 (engine-native review & remediate phases).
Full design: `docs/engine-review-remediate-plan.md` in generacy-ai/tetrad-development.

**Dependencies / seams (not built here):**

- **#1124** — the review executor and the structured findings artifact (sidecar):
  `findings[{severity, file, line?, title, detail, round, status}]`,
  `verdict`, `round`, and the **last-reviewed commit SHA**. This feature reads and
  advances that artifact; it does not define it.
- **#1125** — PR review posting + inline-thread resolution + draft/ready lifecycle.
  This feature decides *which* findings resolve; #1125 owns the GitHub posting.
- **#1131** — merge-conflict re-arm targets a resolution-scoped review; it writes
  the resolution base/head SHAs into the pause-context sidecar
  (`worker/pause-context.ts`). This feature consumes those SHAs to scope the pass;
  #1131 owns producing them.

## Clarifications

### Session 2026-08-19

- Q: When a verification-pass delta re-touches the location of a finding already
  marked `resolved` and the issue is present again → **A: `resolved` is terminal.**
  The re-break is recorded as a **new** finding (subject to the blocking-only-after-
  round-1 rule), never a re-open. Keeps the status machine monotonic and convergent.
- Q: For an `open` finding whose file/line is NOT in the current delta → **A: it
  stays `open` unconditionally.** Only findings whose location appears in the delta
  may transition to `resolved`. Resolution is evidence-based; a genuine fix appears
  in the delta.
- Q: If a verification-pass reviewer emits a new sub-blocking (advisory) finding
  despite the charter → **A: engine-side filter.** The engine drops/discards it
  before it is written to the artifact; the charter is the first line of defense.
- Q: Is the merge-conflict-resolution re-review a verification pass under the same
  convergence charter → **A: same charter.** It increments the round and is
  blocking-only; only the delta source (resolution base/head SHAs) differs.
- Q: When FR-009 falls back to a full review → **A: it stays a verification pass**
  over the full diff — round stays n+1, no new sub-blocking findings; only the delta
  widens to the whole diff.

## User Stories

### US1: Converging re-reviews after remediation (Primary)

**As a** workflow engine driving a PR through review⇄remediate,
**I want** each re-review to verify only the delta since the last review plus the
findings still open,
**So that** the loop converges on the findings that actually block instead of
churning on newly invented nitpicks.

**Acceptance Criteria**:
- [ ] The first review of a PR reviews the full diff and records the reviewed
      commit SHA in the findings artifact.
- [ ] A re-review (round ≥ 2) is scoped to (a) the diff between the last-reviewed
      SHA and the current head, and (b) the findings still `open` in the artifact.
- [ ] The reviewer prompt states the round number and enumerates the prior open
      findings verbatim.
- [ ] Open findings that the delta shows addressed transition to `resolved` in the
      artifact; findings not yet addressed stay `open`.
- [ ] A re-review may raise **new** findings only at/above the profile's blocking
      severity. No new sub-blocking (advisory) findings are recorded after round 1.

### US2: Merge-conflict-resolution re-reviews stay narrow

**As a** workflow engine re-arming into review after a resolved merge conflict,
**I want** the re-review scoped to just the resolution diff,
**So that** resolving a conflict does not re-open review of unrelated, already-
reviewed code.

**Acceptance Criteria**:
- [ ] When the pause-context sidecar carries resolution base/head SHAs, the
      re-review's delta is computed from those SHAs, not from the artifact's
      last-reviewed SHA.
- [ ] The scoped review's input excludes files untouched by the resolution.
- [ ] After a clean scoped review, control proceeds toward validate per the normal
      flow; findings route into the remediate loop.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Determine review mode from the findings artifact: absent/round 0 ⇒ **full review** (round 1); present with a last-reviewed SHA ⇒ **verification pass** (round n+1). | P1 | Round number is the artifact round + 1. |
| FR-002 | Compute the delta for a verification pass as the change set between the last-reviewed commit SHA and the current head SHA. | P1 | Delta = source of "what to re-review". |
| FR-003 | Compose the verification-pass input as the union of (a) the computed delta and (b) the findings still marked `open` in the artifact. | P1 | Both parts required. An `open` finding whose location is NOT in the delta stays `open` unconditionally — only delta-located findings may resolve (Q2). |
| FR-004 | Build the reviewer prompt for a verification pass with the explicit round number and a verbatim list of prior open findings, under a verification charter. | P1 | Charter selection (`standard` vs `verification`) originates in #1124. |
| FR-005 | Constrain the verification charter: confirm each open finding addressed → mark it `resolved`; new findings permitted **only** at/above `blockingSeverity`; no new sub-blocking findings after round 1. The engine also filters: any new sub-blocking finding a reviewer emits after round 1 is dropped before it is written to the artifact (charter is first line of defense; engine drop is authoritative). | P1 | Convergence rule + engine-side enforcement (Q3). |
| FR-006 | Advance artifact state each round: transition addressed findings `open → resolved`, append new blocking findings with the current round, and update the last-reviewed SHA to the head just reviewed. `resolved` is **terminal** — a later delta that re-breaks a resolved location produces a **new** finding (subject to the blocking-only-after-round-1 rule), never a `resolved → open` re-open. | P1 | Status-transition machine; monotonic `resolved` (Q1). |
| FR-007 | For a merge-conflict-resolution re-review, scope the delta to the resolution base/head SHAs supplied by the pause-context sidecar instead of the artifact's last-reviewed SHA. It is the **same verification pass** under the convergence charter — increments the round and is blocking-only; only the delta source differs. | P1 | Depends on #1131 populating those SHAs. Same charter, not a distinct mode (Q4). |
| FR-008 | Overall verdict for a verification pass is `changes-required` iff any finding at/above `blockingSeverity` remains `open` (or a new blocking finding was raised); otherwise `clean`. | P1 | Reuses #1124 severity gating over the post-pass artifact. |
| FR-009 | Degrade safely when a scoping SHA is missing or unresolvable (e.g., last-reviewed SHA no longer in history after a rebase): fall back to a full review rather than an empty/erroring delta. The fallback **remains a verification pass** — round stays n+1, no new sub-blocking findings; only the delta widens to the whole diff (it does NOT reset to round-1 semantics). | P2 | Fail toward a full review, never toward "reviewed nothing"; no advisory-finding reset (Q5). |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Delta computation | Correct | Unit test: given last-reviewed SHA and head SHA, the delta is exactly the intervening change set; identical SHAs ⇒ empty delta. |
| SC-002 | Artifact status transitions | Correct | Unit test: addressed open findings become `resolved`; unaddressed stay `open`; new blocking findings appended with the right round; last-reviewed SHA updated. |
| SC-003 | No sub-blocking findings after round 1 | Enforced | Harness: remediate → re-review adds **zero** new sub-blocking findings; only blocking findings may be added. |
| SC-004 | Addressed findings resolve | Enforced | Harness: remediate that fixes an open finding → re-review marks that finding `resolved` in the artifact. |
| SC-005 | Scoped-review path exercised | Covered | Harness exercises both the remediate re-review path and the merge-conflict resolution-scoped path; the scoped input excludes unrelated files. |
| SC-006 | Round number & prior findings in prompt | Present | Assert the verification-pass prompt contains the round number and the verbatim prior open findings. |

## Assumptions

- The findings artifact from #1124 exists and records `round`, per-finding
  `status`, `severity`, and a last-reviewed commit SHA; this feature reads and
  writes those fields but does not define the schema.
- `blockingSeverity` comes from the per-workflow config (feature default `major`)
  established in #1122/#1124; this feature consumes it, does not set it.
- Merge-conflict pause context (#1131) will carry resolution base/head SHAs; until
  it does, the merge-conflict path falls back per FR-009.
- Commit SHAs recorded in the artifact remain resolvable in the checkout at
  re-review time under normal (non-rebased) flow; the rebase case is FR-009.
- Inline-thread resolution on GitHub is #1125's responsibility; this feature only
  drives the artifact status that #1125 reads.

## Out of Scope

- The review executor, charter prompts, and findings-artifact schema (#1124).
- PR review posting, inline threads, and draft/ready lifecycle (#1125).
- The remediate executor, remediation counter, and remediation-limit gate (#1128).
- Producing the merge-conflict resolution base/head SHAs in the pause context
  (#1131) — this feature only reads them.
- Bugfix-profile charter content and targeted validate (#1134).
- Any change to round-1 (first, full-diff) review behavior beyond recording the
  reviewed SHA.

---

*Generated by speckit*
