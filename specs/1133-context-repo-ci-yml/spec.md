# Feature Specification: Merge readiness — CI skipped≠passed, validate/CI parallel semantics, post-validate approval gate

**Branch**: `1133-context-repo-ci-yml` | **Date**: 2026-08-20 | **Status**: Clarified
**Issue**: [generacy-ai/generacy#1133](https://github.com/generacy-ai/generacy/issues/1133) | **Epic**: [#1120](https://github.com/generacy-ai/generacy/issues/1120) (engine-native review & remediate phases)

## Clarifications

### Batch 1 — 2026-08-20

- Q: CI-wait timeout ceiling and on-timeout behavior → A: Configurable per-workflow `ciWaitTimeoutMs` (sane default); on timeout pause with a resumable `waiting-for:ci`-style gate + `agent:paused`. Never declares green on pending.
- Q: Which run(s) determine the verdict among all runs for the head SHA → A: Aggregate all workflow runs for the head SHA, ignoring `skipped`/`neutral` runs; green only if every non-skipped run is `success` and at least one `success` exists.
- Q: Semantics when NO CI run exists for the head SHA → A: Treat as pending — wait with backoff; if still none at the `ciWaitTimeoutMs` ceiling, enter the resumable-pause terminal state. Never declares green.
- Q: Post-validate gate placement + resume position → A: Keep the gate on the `validate` phase, firing on validate completion once CI is confirmed green; `GATE_MAPPING['implementation-review']` resumes at a terminal/no-op position so neither `validate` nor `implement` re-runs.
- Q: Feature-flag scope + disabled fallback → A: New independent flag `ciMergeGateEnabled`; when disabled, `implementation-review` stays `{ phase: 'implement', resumeFrom: 'validate' }` exactly as today.

## Summary

Today a speckit worker treats a PR as merge-ready once the `validate` phase succeeds. Repo `ci.yml` workflows commonly skip draft PRs, and a **skipped** or **neutral** run reads as SUCCESS in naive status rollups — so a PR whose CI never actually executed can sail through the final gate. The cluster token also lacks `checks:read` in some setups, so the check-runs API is unreliable; the `actions/runs?branch=` readout is the known-working fallback.

This feature makes merge readiness require **both** `validate` success (on the worker) **and** CI actually green on the ready-for-review PR (on GitHub), running the two in parallel and raising the final human-approval gate (`implementation-review`) only once both are confirmed green.

## Context (from issue)

- Repo `ci.yml`s skip draft PRs; skipped runs read as SUCCESS in status rollups — a live merge-gate footgun.
- The cluster token lacks `checks:read` in some setups; `actions/runs?branch=` is the known-working readout.
- Final merge readiness = `validate` success AND CI actually green on the ready PR.
- The `implementation-review` gate currently lives on the `implement` phase (`worker/config.ts:169`) and its resume target is `validate` (`GATE_MAPPING['implementation-review'].resumeFrom = 'validate'`, `worker/phase-resolver.ts:15`). Both must move post-validate.
- Target repos must add `ready_for_review` to their `pull_request` trigger `types` or CI never runs on the draft→ready flip.

## User Stories

### US1: CI-aware merge readiness (Primary)

**As a** cluster operator relying on the final approval gate,
**I want** the engine to treat `skipped`/`neutral`/`cancelled` CI conclusions as NOT passed,
**So that** a PR whose CI was skipped (because it was a draft) can never be presented as merge-ready.

**Acceptance Criteria**:
- [ ] A CI run with conclusion `skipped`, `neutral`, `cancelled`, `timed_out`, `action_required`, or `failure` is evaluated as NOT green.
- [ ] Only `success` (and `null`/in-progress → pending, not passed) counts toward green.
- [ ] When the check-runs API is unavailable/token-limited, readiness is computed from `actions/runs?branch=<head>` for the PR's head SHA instead.
- [ ] A skipped-CI PR blocks the final gate even when `validate` succeeded.

### US2: Parallel validate + CI with backoff wait

**As a** worker driving a clean-reviewed PR,
**I want** `validate` to run locally while CI runs on GitHub after the draft→ready flip, and completion to require both,
**So that** the two independent signals converge without a busy loop.

**Acceptance Criteria**:
- [ ] Sequence: clean review → PR marked ready-for-review → `validate` runs on the worker while CI runs on GitHub.
- [ ] `validate` success + CI still pending → the worker waits (event/poll with backoff), it does not busy-loop and does not declare readiness.
- [ ] `validate` success + CI green → readiness achieved.
- [ ] `validate` failure short-circuits (existing `#1129` review→remediate routing) without waiting on CI.

### US3: Post-validate approval gate

**As a** human reviewer approving the final merge,
**I want** the `implementation-review` gate to fire only after both `validate` and CI are green,
**So that** my approval always reflects a truly green PR.

**Acceptance Criteria**:
- [ ] The `implementation-review` gate no longer fires on `implement` completion; it fires post-validate once validate AND CI are green.
- [ ] `GATE_MAPPING['implementation-review']` resume target is reworked so a satisfied gate resumes correctly from the post-validate position (no re-run of `validate` or `implement` on resume).
- [ ] The gate answer yields a merge-eligible state consumable by cockpit / `cockpit_merge`.

### US4: Target-repo migration

**As a** maintainer of a target repo,
**I want** clear docs that CI must trigger on `ready_for_review`,
**So that** the draft→ready flip actually starts a CI run for the engine to evaluate.

**Acceptance Criteria**:
- [ ] A migration note documents adding `ready_for_review` to the `pull_request` trigger `types` in target-repo `ci.yml`.
- [ ] Docs state the readiness contract (validate AND CI green) and the skipped≠passed rule.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add engine-side CI merge-readiness evaluation that maps CI conclusions to `green` / `pending` / `not-passed`, treating `skipped`, `neutral`, `cancelled`, `timed_out`, `action_required`, `failure` as NOT green and only `success` as green. | P1 | In-progress/`null` → pending. |
| FR-002 | When the check-runs API is unavailable or token-limited (no `checks:read`), fall back to `actions/runs?branch=<head>` filtered to the PR head SHA to derive the same green/pending/not-passed verdict. The verdict aggregates **all** workflow runs for the head SHA while **ignoring** `skipped`/`neutral` runs: green only if every non-skipped run is `success` **and** at least one `success` exists. | P1 | `packages/github-actions/src/operations/runs.ts` is the known-working readout. Skipped-of-an-unrelated-workflow is non-blocking; skipped≠passed. |
| FR-003 | After a clean review, mark the PR ready-for-review, then run `validate` on the worker while CI runs on GitHub; treat completion as requiring both validate success and CI green. | P1 | Reuses existing `markReadyForReview` (`phase-loop.ts:1419`). |
| FR-004 | On `validate` success with CI pending (including "no CI run yet found" for the head SHA), wait for CI via event/poll with bounded backoff (not a busy loop) before evaluating readiness. The ceiling is a configurable per-workflow key `ciWaitTimeoutMs` with a sane default; on timeout, pause with a resumable `waiting-for:ci`-style gate + `agent:paused` (never declares green). | P1 | "No run found" is pending (Q3-A), not fail-fast. Backoff strategy required. |
| FR-005 | Keep the `implementation-review` gate attached to the `validate` phase but make it fire only on `validate` completion **once CI is confirmed green** (both signals green). Do not relocate the gate to a new phase. | P1 | Gate def stays with `validate`; CI wait folded into validate's completion (Q4-A). |
| FR-006 | Rework `GATE_MAPPING['implementation-review']` (`worker/phase-resolver.ts:9-17`) so it resumes at a terminal/no-op position — a satisfied gate re-runs neither `validate` nor `implement`. | P1 | Keep `speckit-feature` and `speckit-bugfix` consistent. |
| FR-007 | Expose the achieved merge-eligible state so cockpit / `cockpit_merge` can consume it (gate answer → merge-eligible). | P1 | |
| FR-008 | Provide a migration note + docs: target repos must add `ready_for_review` to `pull_request` trigger `types`, and document the readiness contract. | P2 | |
| FR-009 | Gate CI-aware merge readiness behind a new independent flag `ciMergeGateEnabled` (separate from `reviewPhaseEnabled`). When disabled, `implementation-review` stays `{ phase: 'implement', resumeFrom: 'validate' }` exactly as today (byte-identical, no CI check). | P1 | New flag threaded like `reviewPhaseEnabled` in `phase-resolver.ts`; not coupled to it. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Skipped-CI PR does not reach the final gate | 100% | Harness: PR with `validate` green + CI conclusion `skipped` → readiness blocked, `implementation-review` NOT raised. |
| SC-002 | Green CI + green validate raises the final gate | 100% | Harness: both green → `implementation-review` gate raised. |
| SC-003 | Gate answer → merge-eligible state | consumable | Harness: satisfying `implementation-review` yields a merge-eligible state cockpit can read. |
| SC-004 | Check-runs-unavailable path uses `actions/runs` fallback and yields identical verdict | 100% | Unit: token without `checks:read` → readiness derived from `actions/runs?branch=`. |
| SC-005 | No busy loop while CI pending | 0 tight loops | Wait path uses bounded backoff (event/poll), not immediate re-poll. |
| SC-006 | No behavior change when path disabled | byte-identical | Existing feature/bugfix runs resolve same start phase + gate as pre-change. |

## Assumptions

- The PR head SHA is resolvable at the point readiness is evaluated (after the draft→ready flip).
- `actions/runs?branch=<head>` returns runs that can be filtered to the PR head SHA and mapped to a conclusion.
- A bounded CI-wait timeout (`ciWaitTimeoutMs`, configurable per-workflow, sane default) is acceptable; on timeout the workflow pauses with a resumable `waiting-for:ci`-style gate + `agent:paused` rather than declaring green.
- "No CI run found for the head SHA" is treated as pending (wait then time out), not fail-fast — the unmigrated-repo case converges on the same timeout pause.
- Only the primary PR's CI is gated in this issue; sibling/multi-repo CI aggregation (if any) follows existing linked-PR patterns.

## Out of Scope

- Adding `checks:read` to cluster tokens (this feature works around its absence).
- Editing target repos' `ci.yml` files (documented as a migration note only).
- Auto-merging the PR once merge-eligible (cockpit / `cockpit_merge` owns the merge action).
- Aggregating CI across many linked repos beyond the existing linked-PR sibling handling.

---

*Generated by speckit*
