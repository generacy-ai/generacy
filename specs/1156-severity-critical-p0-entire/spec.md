# Feature Specification: Wire the PR review-posting + draft/ready lifecycle (readFindingsArtifact never supplied)

**Branch**: `1156-severity-critical-p0-entire` | **Date**: 2026-08-21 | **Status**: Draft

## Summary

**Severity: critical (P0).** The entire #1125 PR-visibility/lifecycle block is dead in production. The review side-effect block at `phase-loop.ts:1591-1607` only runs when BOTH `deps.reviewPoster` and `deps.readFindingsArtifact` are wired, but `claude-cli-worker.ts:742-753` wires only the poster — its own comment says "#1124 will supply the reader." #1124 shipped without the reader and the epic (generacy-ai/generacy#1120) closed, so the guard `deps.readFindingsArtifact` is permanently `undefined` and the block never executes.

Confirmed downstream consequences while the reader is missing:

- No COMMENT-event review is ever posted per round — reviewers see no engine findings on the PR.
- Verification (re-review, round ≥ 2) passes never resolve inline threads.
- `markReadyForReview` on a clean verdict never fires, so CI never runs in parallel with validate; the only ready-marking is the post-validate call at `phase-loop.ts:1277`, which serializes CI inside `ciWaitTimeoutMs`.
- `convertToDraftIfEngineMarkedReady` at the remediate seam (`phase-loop.ts:1617`) is a guaranteed no-op.
- The PR-feedback monitor's engine-marker exclusion currently guards review threads that can never exist.

Fixing this is not a one-liner. Wiring the reader alone would immediately expose four latent defects that the dead code path has been masking (see functional requirements). This issue delivers the reader **and** the four supporting corrections so the review-posting + draft/ready lifecycle works end-to-end and survives pause / re-entry / cross-run.

Filed from a post-merge code review of epic generacy-ai/generacy#1120. Part of follow-up epic generacy-ai/generacy#1153. All line refs at develop `155b3464`.

## User Stories

### US1: Engine posts its review findings to the PR (primary)

**As a** human reviewer (or the cockpit auto-driver) watching a speckit PR,
**I want** the engine's review-phase findings posted as a single COMMENT-event review each round,
**So that** blocking and advisory findings are visible on the PR instead of being silently discarded.

**Acceptance Criteria**:
- [ ] When the `review` phase completes successfully and produces a review-findings sidecar, exactly one COMMENT-event review is posted for that round.
- [ ] Findings whose anchor points at a diffable RIGHT-side line become inline comments; all other findings fall back to the review body (no finding dropped).
- [ ] Each posted review carries the engine round marker and each finding carries its per-finding marker.

### US2: Clean verdict marks the PR ready so CI runs in parallel

**As an** operator waiting on a clean feature,
**I want** a clean review verdict to mark the PR ready-for-review before validate begins,
**So that** CI runs concurrently with validate rather than serially inside `ciWaitTimeoutMs`.

**Acceptance Criteria**:
- [ ] On a `clean` verdict, the PR (and linked siblings) is marked ready-for-review during the review side-effect block, ahead of validate.
- [ ] On a `changes-required` verdict, the PR is NOT marked ready.

### US3: Posting is correct across pause, re-entry, and multiple runs

**As** the workflow engine re-entering `review` after a pause or on a fresh run,
**I want** round number, dedupe, thread resolution, and draft/ready state derived from the persisted sidecar (not loop-local, in-memory state),
**So that** re-review rounds post correctly, resolve prior threads, and never mis-target or double-post.

**Acceptance Criteria**:
- [ ] The round used for posting and thread-resolution gating is read from the sidecar, not from the loop-local counter that resets to 1 each run.
- [ ] On re-entry at round ≥ 2, prior inline threads for resolved findings are resolved.
- [ ] The review is posted against the live PR number that exists at posting time (never PR #0).
- [ ] An `address-pr-feedback` re-entry on a PR the engine marked ready in a previous run correctly converts it back to draft when a remediate round begins.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Supply `deps.readFindingsArtifact` at the worker wiring site so the review side-effect block at `phase-loop.ts:1591-1607` executes in production. | P0 | The single change that makes the whole block live. |
| FR-002 | Provide a bridge from the engine-written `ReviewArtifact` sidecar (`review-artifact.ts`) to the `FindingsArtifact` shape the `ReviewPoster` consumes (`review-findings-artifact.ts`). | P0 | Map `severity: critical\|major\|minor` → `blocking\|advisory` **via the configured `blockingSeverity` threshold** (`blocking` iff `SEVERITY_RANK[severity] >= SEVERITY_RANK[blockingSeverity]`, else `advisory`) — consistent with `computeVerdict` (Clarify Q1=A); combine `title`/`detail` → `text`; `file`+optional `line` → optional `anchor`; `status: open\|resolved` → `resolved?`. |
| FR-003 | Synthesize a stable per-finding `marker` during the bridge, since `ReviewArtifact` findings carry no id. | P0 | Must be stable across rounds so re-review thread matching (per-finding marker) works. **Marker = hash of `file` + `title`** (Clarify Q2=A), tolerant of `line`/`detail` drift between rounds. |
| FR-004 | Post the review against the live PR number resolved at posting time, not a value captured before the PR exists. | P0 | Today `ReviewPoster` is constructed with `prManager.getPrNumber() ?? 0`; early rounds would post to PR #0. **Inject a `getPrNumber: () => number \| undefined` getter callback into `ReviewPoster`** that resolves live on each `postRound`/`resolveResolvedThreads` call and skips when undefined (Clarify Q3=A) — no method-signature change. |
| FR-005 | Derive the review round from the persisted sidecar, not from the loop-local `reviewRound` (which resets to 1 each run at `phase-loop.ts:330-331`). | P0 | Otherwise `isRoundAlreadyPosted` dedupe-skips after any pause/re-entry, and the round ≥ 2 gate skips thread resolution on re-entry rounds. **`readFindingsArtifact` returns `{ artifact, round }`** and the block passes that round (Clarify Q4=A) — no change to the shared `FindingsArtifact` shape, no redundant re-read. |
| FR-006 | Make the "engine marked this PR ready" signal survive across worker runs so a later `address-pr-feedback` re-entry converts a previously-ready PR back to draft. | P0 | Today `markedReadyByEngine` (`pr-manager.ts:41`) is in-memory per run. **Persist the flag in the review-findings sidecar** (add a field) and read it on re-entry to reconstruct `markedReadyByEngine` (Clarify Q5=A). |
| FR-007 | Never demote a PR a human marked ready. | P0 | Preserve the existing guard semantics of `convertToDraftIfEngineMarkedReady`. |
| FR-008 | All posting / lifecycle calls remain best-effort — a failure logs and is swallowed, never failing the workflow. | P1 | Preserve existing `ReviewPoster`/`PrManager` non-fatal contract. |
| FR-009 | The whole path stays inert when the review phase is disabled (`reviewPhaseEnabled=false` / no sidecar produced). | P1 | No behavior change for clusters not running the review phase. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Reviews posted per completed review round with a produced sidecar | Exactly 1 COMMENT-event review | Integration test drives a review-completing loop and asserts one `createReview` call with `event: COMMENT`. |
| SC-002 | Findings surfaced (none dropped) | 100% of findings appear inline or in the body | Unit test on the bridge + poster asserts every bridged finding lands in `inline` ∪ `body`. |
| SC-003 | PR number targeted by a post | Always the live PR, never 0 | Test that constructs the flow with a PR created mid-loop and asserts the post targets the real number. |
| SC-004 | Correct posting/resolution after pause + re-entry | Round from sidecar; no dedupe-skip; threads resolved at round ≥ 2 | Test re-enters with a persisted sidecar round ≥ 2 and asserts a fresh post + `resolveResolvedThreads` invoked. |
| SC-005 | Cross-run draft conversion | A previous-run-ready PR converts to draft on remediate re-entry | Test simulates a run boundary and asserts `convertPullRequestToDraft` fires on the next remediate seam. |
| SC-006 | Human-marked-ready PRs | Never demoted by the engine | Test asserts convert-to-draft is a no-op when the engine did not mark the PR ready. |

## Assumptions

- The engine-written `ReviewArtifact` sidecar (`review-artifact.ts`) is the source of truth for verdict, findings, round, and cross-run lifecycle state; the loop-local `reviewRound` and in-memory `markedReadyByEngine` are not.
- Severity mapping into blocking/advisory follows `computeVerdict`'s configurable per-workflow `blockingSeverity` threshold — a finding is `blocking` iff `SEVERITY_RANK[severity] >= SEVERITY_RANK[blockingSeverity]`, else `advisory` (Clarify Q1=A). This is a single source of truth with verdict computation, so at the default (`blockingSeverity = critical`) a `major` finding renders advisory, matching the clean verdict `computeVerdict` would score.
- The `ReviewPoster` public surface (`postRound`, `resolveResolvedThreads`) and the `PrManager` lifecycle methods (`markReadyForReview`, `convertToDraftIfEngineMarkedReady`, `getPrNumber`) are correct as-is; this issue supplies the missing inputs and persistence, not a rewrite of those components.
- The review phase feature flag and sidecar production from #1124/#1128 are present on the branch and authoritative.

## Out of Scope

- Rewriting `ReviewPoster`, the review executor, or the remediate executor.
- Changing the PR-feedback monitor's engine-marker exclusion logic (#1130) beyond letting it now guard threads that actually exist.
- Any change to the CI merge gate (#1133) semantics; this issue only restores parallel-CI behavior by making the clean-verdict ready-marking fire.
- Migrating or backfilling sidecars for in-flight PRs created before this fix.

---

*Generated by speckit*
