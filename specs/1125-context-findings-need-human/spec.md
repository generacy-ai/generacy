# Feature Specification: PR review posting (COMMENT-event) + draft/ready lifecycle

**Branch**: `1125-context-findings-need-human` | **Date**: 2026-08-19 | **Status**: Draft

## Summary

Wire the review phase's engine-internal findings artifact to the pull request. Each
review round posts findings as a **single COMMENT-event** PR review — never a
`REQUEST_CHANGES` event, which returns HTTP 422 on the author's own PR — carrying
inline threads wherever a finding has a file/line anchor and a review body that
includes a machine-greppable engine marker plus the round number. The same phase
drives the PR's draft/ready lifecycle, which in turn drives CI: a clean verdict marks
the PR ready **before** validate starts (so CI runs in parallel with validate);
entering remediate after the PR was marked ready converts it **back to draft**; the
next clean verdict re-marks it ready. On verification (re-review) passes, inline
threads for findings the artifact marks resolved are resolved on GitHub.

This is P2 of the engine-native review & remediate epic
([generacy-ai/generacy#1120](https://github.com/generacy-ai/generacy/issues/1120)).
It consumes the structured findings artifact produced by the review executor
([#1124](https://github.com/generacy-ai/generacy/issues/1124)) and turns it into
GitHub side effects; it does not itself decide the verdict.

## Context

Findings need human visibility on the PR, and the PR's draft/ready state drives CI.
Three platform constraints shape the design:

- **COMMENT-event reviews only** — an author cannot submit a `REQUEST_CHANGES` review
  on their own PR (GitHub returns 422). All engine reviews must use the `COMMENT`
  event.
- **Draft PRs skip CI** — repo `ci.yml` workflows skip on draft PRs, so the PR must be
  marked ready for CI to start, and reverted to draft when work resumes.
- **Skipped ≠ passed** — a skipped CI run reads as SUCCESS in a status rollup, so
  merge readiness (a later epic issue, #1133) must not treat a draft-skipped run as a
  green check. In scope here only insofar as this feature must not leave a PR ready
  while remediation is in flight.

## User Stories

### US1: Findings visible on the PR as one COMMENT review per round (P1)

**As a** human reviewer of an engine-driven PR,
**I want** each review round's findings posted as a single COMMENT-event PR review with
inline threads where anchors exist and a greppable engine marker in the body,
**So that** I can see the engine's findings in the normal PR review UI without the
engine ever tripping the own-PR `REQUEST_CHANGES` 422.

**Acceptance Criteria**:
- [ ] Every engine-posted review uses the `COMMENT` event; no `REQUEST_CHANGES` event
      is ever emitted.
- [ ] Findings with a valid file/line anchor post as inline threads on that file/line;
      findings without an anchor appear in the review body.
- [ ] The review body contains a machine-greppable engine-authored marker and the
      round number.
- [ ] Advisory (sub-blocking) findings are clearly marked non-blocking, distinct from
      blocking findings.
- [ ] A round posts exactly one review (not one review per finding).

### US2: Clean verdict marks the PR ready before validate (P1)

**As the** workflow engine,
**I want** a clean review verdict to mark the PR ready for review at the end of the
review phase, before validate starts,
**So that** CI begins running in parallel with validate instead of after it.

**Acceptance Criteria**:
- [ ] On a clean verdict, `markReadyForReview` is called at the end of the review
      phase, before the validate phase begins.
- [ ] Marking ready is idempotent (a no-op on an already-ready PR) and best-effort
      (a failure logs a warning and does not fail the workflow).

### US3: Entering remediate converts a ready PR back to draft (P2)

**As the** workflow engine,
**I want** entering the remediate phase after the PR was marked ready to convert the PR
back to draft, and the next clean verdict to re-mark it ready,
**So that** CI does not run against a PR that is actively being remediated.

**Acceptance Criteria**:
- [ ] Entering remediate after the PR was previously marked ready converts it to draft
      via the GraphQL `convertPullRequestToDraft` mutation.
- [ ] Converting to draft is idempotent (a no-op on an already-draft PR) and
      best-effort (a failure logs a warning and does not fail the workflow), mirroring
      `markReadyForReview`.
- [ ] The next clean verdict re-marks the PR ready.

### US4: Verification passes resolve threads for resolved findings (P2)

**As a** human reviewer,
**I want** inline threads resolved on GitHub when the findings artifact marks the
corresponding finding resolved on a verification (re-review) pass,
**So that** the PR's unresolved-thread count converges as the engine confirms fixes.

**Acceptance Criteria**:
- [ ] On a verification pass, each inline thread whose finding the artifact marks
      resolved is resolved via the existing `resolveReviewThread` mutation.
- [ ] Threads for findings the artifact does not mark resolved are left unresolved.
- [ ] Thread resolution is best-effort — a failure to resolve one thread logs a
      warning and does not fail the workflow or block resolution of other threads.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Post each review round as exactly one PR review using the `COMMENT` event. | P1 | Own-PR `REQUEST_CHANGES` → 422; never emit that event. |
| FR-002 | Post findings with a file/line anchor as inline review threads at that anchor; render findings without an anchor in the review body. | P1 | Anchors come from the findings artifact (#1124). |
| FR-002a | Pre-check anchor diffability before posting; a finding whose anchor points outside the PR diff falls back to the review body (referencing its intended file/line) and is never dropped. | P1 | [Q1→A] A bad inline anchor 422s the whole atomic review (#1047); "postable inline" is decided by the diffability pre-check, not by anchor presence alone. |
| FR-003 | Include a machine-greppable engine-authored marker and the round number in every engine review body, plus a stable per-finding marker/ID (from the #1124 artifact) in each inline comment body. | P1 | [Q2→A] Per-finding marker enables cross-round thread matching (FR-009); body marker+round enables monitor exclusion (#1130) and round-level idempotency (FR-010). |
| FR-004 | Mark advisory (sub-blocking) findings as clearly non-blocking, visually distinct from blocking findings. | P1 | Severity/blocking classification comes from the artifact. |
| FR-005 | On a clean verdict, call `markReadyForReview` at the end of the review phase, before validate starts. | P1 | [Q5→A] "Clean verdict" = the artifact's explicit `verdict: clean` field; this feature never re-derives it from per-finding severity. Reuses existing `worker/pr-manager.ts` method. |
| FR-006 | Add a `convertPullRequestToDraft` (GraphQL) capability to the GitHub client and call it on remediate entry **only if the engine itself previously marked the PR ready** (engine-tracked flag). | P2 | [Q3→B] Never touch a PR the engine did not mark ready (e.g., human-marked-ready). New client method; GraphQL mutation. |
| FR-007 | Re-mark the PR ready on the next clean verdict after a draft conversion. | P2 | Same path as FR-005. |
| FR-008 | Make ready↔draft transitions and thread resolution idempotent and best-effort — failures log a warning and do not fail the workflow. | P1 | Mirrors existing `markReadyForReview` semantics. |
| FR-009 | On verification (re-review) passes, resolve inline threads for findings the artifact marks resolved via `resolveReviewThread`; match a resolved finding to its earlier thread by grepping the per-finding marker (FR-003) in `getPRReviewThreads` comment bodies. | P2 | [Q2→A] Marker match, not path+line equality (lines drift/collide). Existing mutation; artifact drives which threads resolve. |
| FR-010 | Dedupe review posting per round: before posting, grep existing engine reviews by body marker + round number and skip if that round is already posted. | P1 | [Q4→A] Survives mid-review retry/worker restart; #1124 guarantees the artifact, not GitHub-side single-post. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `REQUEST_CHANGES` events emitted by the engine | 0 | Harness asserts no review is submitted with `event: REQUEST_CHANGES`. |
| SC-002 | Clean verdict outcome | PR marked ready | Harness: clean verdict → PR is ready before validate starts. |
| SC-003 | Changes-required outcome after a prior ready state | PR converted to draft | Harness: entering remediate after ready → PR is draft. |
| SC-004 | Engine marker presence | Marker on every engine review | Harness greps each engine review body for the marker. |
| SC-005 | Thread resolution fidelity | Matches artifact | Harness: threads posted and resolved match the findings artifact (resolved findings → resolved threads; unresolved → unresolved). |
| SC-006 | Round number presence | Round number on every engine review | Harness asserts each engine review body carries its round number. |

## Assumptions

- The review executor (#1124) produces a structured findings artifact (sidecar
  pattern) that, per finding, carries the finding text, an optional file/line anchor,
  a blocking/advisory (severity) classification, a stable per-finding marker/ID, and —
  on re-review — a resolved flag. The artifact also carries a single explicit
  `verdict: clean|changes-required` field [Q5→A]. This feature consumes that artifact
  and does not compute or re-derive the verdict; #1124 already folds advisory-only
  rounds into `verdict=clean` via its blocking-severity gating.
- The engine tracks whether it marked the PR ready (a `markedReadyByEngine` flag) so
  that remediate-entry draft conversion only fires on PRs the engine itself made ready,
  leaving human-marked-ready PRs untouched [Q3→B].
- A finding's anchor is only usable inline if it lands in the PR diff. The engine
  pre-checks diffability and renders any anchored-but-undiffable finding in the review
  body (referencing its intended file/line) rather than attempting an inline comment
  that would 422 the whole review [Q1→A].
- The round number is available from the review phase's loop iteration (review is a
  linear phase after implement; re-reviews are driven by the review⇄remediate loop).
- `markReadyForReview` already exists (`worker/pr-manager.ts:424-446`) and is
  idempotent/best-effort; `resolveReviewThread` and `getPRReviewThreads` already exist
  on the GitHub client. Only `convertPullRequestToDraft` is net-new.
- Sibling/linked PRs, if any, follow the same ready/draft transition semantics as the
  primary PR (matching `markSiblingsReadyForReview`), unless a later epic issue says
  otherwise.
- "Verification pass" means a re-review round (round ≥ 2), where the artifact carries
  resolved flags for previously-open findings.

## Out of Scope

- Deciding the review verdict or generating the findings artifact — that is the review
  executor (#1124).
- Delta-scoped re-review convergence logic (which findings re-appear on round N) —
  that is #1126.
- The remediate executor, remediation counter, and `waiting-for:remediation-limit`
  gate — that is #1128.
- Excluding engine-authored threads from the PR-feedback monitor and routing external
  feedback into remediate — that is #1130.
- Merge-readiness rollup semantics (skipped ≠ passed, validate/CI parallelism gating,
  post-validate approval gate) — that is #1133.
- Bugfix-profile charter and targeted validate — that is #1134.

---

*Generated by speckit*
