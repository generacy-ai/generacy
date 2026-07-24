# Feature Specification: Deterministic branch/spec-slug + PR dedup on speckit workflow re-entry

**Branch**: `1043-summary-when-speckit-feature` | **Date**: 2026-07-24 | **Status**: Draft
**Issue**: [generacy-ai/generacy#1043](https://github.com/generacy-ai/generacy/issues/1043)
**Type**: `type:bug` · `workflow:speckit-bugfix`

## Summary

When the `speckit-feature` workflow **re-enters `implement`** (observed immediately after a `cockpit_advance(implementation-review)`), the orchestrator can cut a **fresh branch under a different spec-slug** and open a **second PR** containing only regenerated spec artifacts — no source, no tests, no changeset — orphaning the real implementation on the original branch/PR.

The fix requires: (a) **deterministic + idempotent** branch and spec-slug derivation from the issue identity so re-entries land on the same branch, (b) **per-issue PR dedup** so a re-entry reuses the existing PR rather than opening a second one, and (c) an investigation into why `implementation-review` re-cycles (`waiting-for:implementation-review` + `agent:paused` re-applied after `completed:validate`) which is the *trigger* that surfaces the duplicate-PR path.

## Clarifications

Resolved 2026-07-24 (see [`clarifications.md`](./clarifications.md) for full context):

- **Q1 → A**: The single source of truth for the issue → `<N>-<slug>` binding is **remote git branches only**. On every entry, enumerate remote branches matching `^<N>-` and reuse the oldest match. No local index, no Redis key, no issue-body marker. Chosen because the remote branch is the only artifact that survives fresh clusters and cold caches; the Redis-key path is the stale-key/TTL failure mode that produced #849.
- **Q2 → A**: When the remote contains multiple `<N>-*` branches AND multiple open PRs for issue N, **the oldest open PR wins** — its head branch is canonical; any other `<N>-*` branch without an associated open PR is ignored (not deleted). Encodes the one-open-PR-per-issue invariant and resolves the #1038 incident correctly (keep real PR #1039, ignore spec-only #1041).
- **Q3 → A**: This PR ships **US1 + US2 only**. US3 (review-gate re-cycle) is deferred to a follow-up issue that gates on #849's landing. FR-006 stays in the spec as intent, but its acceptance test is not required to land here. Chosen because FR-001..FR-004 make the duplicate-PR outcome impossible even if the re-cycle continues, so US1/US2 land independently.
- **Q4 → A**: **Reuse the existing slug derivation** and persist the result ("first-derived wins forever"). This PR does not modify slug-generation logic. Under Q1-A, the first-created remote branch IS the persisted first-derived slug, so FR-002's reuse-oldest-branch enforces first-derived-wins with zero re-derivation.
- **Q5 → A**: **Apply dedup enforcement unconditionally to all workflows**. The "Out of Scope" `speckit-feature` clause bounds test coverage, not implementation scope. This spec's own header is `workflow:speckit-bugfix`, so gating on `speckit-feature` would leave this very bugfix run unprotected; the one-open-PR / deterministic-branch invariant is universally correct.

## Observed Incident

Epic `generacy-ai/generacy-cloud#850`, phase P5, issue `generacy-ai/generacy#1038`:

| | PR #1039 (real) | PR #1041 (duplicate) |
|---|---|---|
| Branch | `1038-issue-1038` | `1038-part-cockpit-remote-gates` |
| Created | 2026-07-23 19:21Z | 2026-07-24 16:12Z (~1 min after the `implementation-review` advance) |
| Contents | full impl: `packages/cockpit/src/gates/*`, MCP gate-query tools, `packages/orchestrator/src/routes/cockpit-gates.ts`, cloud-gate-query-client, **tests + changeset** | **spec/doc only**: `specs/1038-part-cockpit-remote-gates/*` + `CLAUDE.md` — no source, no tests, no changeset |
| CI | red (unrelated tinypool `ERR_IPC_CHANNEL_CLOSED` teardown flake; all tests pass) | green (nothing to build/test) |

After the advance, the doorbell showed rapid churn (`phase:implement → agent:in-progress → phase:validate → pending → phase:implement`) and PR #1041 was created mid-churn, while `cockpit_status` continued to report #1038's PR as #1039. The `waiting-for:implementation-review` + `agent:paused` labels were also re-applied on #1038 after `completed:validate` (review-gate re-cycling).

## Impact

- **Two open PRs per issue.** The spurious one would "merge nothing useful" and pollute `specs/` with a duplicate slug directory.
- **Non-deterministic spec-slug derivation.** `1038-issue-1038` vs `1038-part-cockpit-remote-gates` for the same issue indicates the slug is being re-derived from ambient context (issue title, working directory, PR body) rather than from stable issue identity.
- **Auto-merge automation stalls.** `cockpit_merge` sees a draft / `REVIEW_REQUIRED` PR; a naive picker could merge the empty one.
- **Field resolution required manual intervention:** closed #1041 as spurious; admin-squash-merged #1039 after CI flake cleared.

## User Stories

### US1: Workflow re-entry lands on the original branch and PR

**As** an operator running `/cockpit:auto` on an epic,
**I want** every re-entry of the `speckit-feature` `implement` phase for an issue to reuse the same branch, spec-slug, and PR that were created on first entry,
**So that** implementation, tests, and changeset stay in one place and CI/review/merge automation isn't split across two PRs.

**Acceptance Criteria**:
- [ ] Re-entering `implement` for an already-open PR on issue N MUST reuse that PR's branch (no new branch cut).
- [ ] The spec directory under `specs/<slug>/` MUST resolve to the same `<slug>` as on first entry, regardless of workflow re-entry count or intermediate advance/pause cycles.
- [ ] No second PR opens for the same issue while a non-merged PR already exists.

### US2: Deterministic spec-slug derived from issue identity

**As** an author reviewing the epic tree,
**I want** the spec-slug for issue N to be a pure function of the issue's stable identity (issue number + first-created slug),
**So that** two workflow entries on the same issue can never produce two different `specs/<N>-*` directories.

**Acceptance Criteria**:
- [ ] Given issue N with an existing branch `N-<slug>`, any subsequent branch-derivation call MUST return the same `N-<slug>`.
- [ ] Given issue N with no prior branch, branch-derivation MUST produce a slug from a stable input (e.g., issue title at first-entry time, persisted), not from ambient state that varies across re-entries.
- [ ] A migration/lookup path exists: on re-entry, if a branch matching `N-*` already exists on the remote, it's reused verbatim rather than re-derived.

### US3: Investigate & fix the review-gate re-cycle that triggers re-entry

**As** an orchestrator maintainer,
**I want** to understand why `waiting-for:implementation-review` + `agent:paused` were re-applied on issue #1038 after `completed:validate` and after the `implementation-review` advance,
**So that** the trigger that surfaces the duplicate-PR path is eliminated (defence in depth alongside US1/US2).

**Acceptance Criteria**:
- [ ] Root cause of the review-gate re-cycle is identified and documented (e.g., stale gate-dedupe key, label-monitor race, PhaseTracker key-miss — see [[label-monitor-service]], [[phase-tracker-service]], sibling fix #849 pause-paired resume-dedupe clear).
- [ ] A regression test asserts that a `completed:validate` + `implementation-review` advance sequence does not re-apply `waiting-for:implementation-review` on the same head SHA.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Branch derivation for issue N MUST be idempotent: a second call with the same issue MUST return the same branch name as the first call. | P1 | Purely deterministic; no reliance on issue title mutations, PR body content, or working directory state that can drift between re-entries. |
| FR-002 | Before deriving a new branch, orchestrator MUST query the remote for existing branches matching `<N>-*` and reuse the **oldest** match if present. Persistence is **remote git branches only** — no local index, no Redis key, no issue-body marker (per Q1 → A). | P1 | Handles the case where the slug was persisted only in git — matches the observed remediation and survives fresh clusters and cold caches. |
| FR-003 | Before opening a PR for issue N, orchestrator MUST query the remote for open PRs whose head branch matches the derived branch (or any `<N>-*` branch) and reuse the match instead of opening a second. When multiple candidates exist, **the oldest open PR wins**; its head branch is canonical; any other `<N>-*` branch without an associated open PR is ignored (not deleted) (per Q2 → A). | P1 | Guarantees "one open PR per issue" invariant. Closed/merged PRs do not block. |
| FR-004 | Spec-slug used for `specs/<slug>/` MUST equal the branch name (existing convention) and MUST persist across `implement` re-entries — i.e., if `specs/<slug>/` already exists on the branch, it MUST NOT be regenerated under a different `<slug>`. | P1 | Prevents `specs/` pollution and orphaned directories. |
| FR-005 | On re-entry, if the orchestrator detects that its would-be new branch/PR differs from an existing open branch/PR for the same issue, it MUST log a structured warning (`{ event: 'workflow-reentry-branch-mismatch', issue, existing, wouldCreate }`) and reuse the existing one. | P2 | Observability — surfaces the class of bugs #1043 represents in future incidents. |
| FR-006 | The trigger investigated in US3 — re-application of `waiting-for:implementation-review` + `agent:paused` after `completed:validate` on the same PR head — MUST be prevented at its source. | **Deferred** | Per Q3 → A: US3 (and its acceptance test) deferred to a follow-up issue that re-checks after #849 lands. FR-001..FR-004 make the duplicate-PR outcome impossible even if the re-cycle continues. FR-006 stays as intent only. |
| FR-007 | Existing spec directories under `specs/` with the shape `<N>-*` MUST NOT be created a second time under a different suffix by any code path in the orchestrator worker. | P1 | Filesystem-level invariant; enforceable in code via an existence-check before scaffold. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Duplicate spec-only PRs per issue after `implementation-review` advance | 0 across all epics for 30 consecutive days post-merge | Query GitHub for open PRs grouped by issue number in title/body; any pair of open PRs on the same issue is a failure. |
| SC-002 | `specs/<N>-*` directories per issue in a single PR | Exactly 1 for every issue that has entered `implement` | Regression check in CI: `ls specs/` grouped by leading numeric prefix; count > 1 fails the check. |
| SC-003 | Re-entry `implement` reuses existing branch | 100% of re-entries | Structured log assertion: `event: 'workflow-reentry-branch-reused'` emitted; no `git push` creating a new branch on re-entry. |
| SC-004 | Re-cycled `waiting-for:implementation-review` labels after `completed:validate` on same head SHA | 0 in production | Label-monitor emits `event: 'gate-recycle-detected'` on any such re-application; alert threshold = any occurrence. |
| SC-005 | Manual PR closure / spec-directory cleanup ops | 0 per week | Operator interventions tracked in the epic post-mortem log; zero for 30 days = pass. |

## Assumptions

- The orchestrator has a stable identifier for each issue (issue number + owner/repo) available at branch-derivation time.
- Existing branches for an issue can be enumerated from the remote via `gh api` or equivalent.
- The `specs/<slug>/` layout convention (one directory per branch, slug == branch name) is unchanged.
- The `implementation-review` re-cycle in US3 is a related but separable defect; fixing FR-001..FR-004 makes the duplicate-PR outcome impossible *even if the re-cycle continues*, so US1/US2 can land independently of US3.
- Related sibling fix #849 (pause-paired resume-dedupe clear) may resolve US3 outright; this spec should re-check after #849 lands before doing independent debugging work.

## Out of Scope

- Cleanup of pre-existing duplicate `specs/<N>-*` directories in historical branches (one-off manual task).
- Backfilling `<N>-<slug>` renames on branches created before the fix ships (existing PRs continue on their original branches).
- Behavior change to `cockpit_merge` picker logic (this spec ensures there is only one candidate; the picker doesn't need a tiebreaker).
- Rewriting `cockpit_status` to reflect multiple PRs per issue (invariant enforcement means `cockpit_status` stays 1-PR-per-issue by construction).
- ~~Cross-workflow (non-`speckit-feature`) branch/PR dedup~~ — **superseded by Q5 → A**: dedup enforcement applies unconditionally to all workflows. The `workflow:speckit-feature` phrasing here originally bounded test coverage, not implementation scope.
- Test coverage in this PR is scoped to `workflow:speckit-feature` scenarios; broader per-workflow regression tests can land as follow-ups.
- Slug-generation logic itself is unchanged (per Q4 → A: reuse existing derivation and persist via the remote-branch-oldest-match rule).

## Related work

- Sibling fix [#849 — Pause-Paired Resume-Dedupe Clear](https://github.com/generacy-ai/generacy/pull/849) — addresses a class of stale-dedupe-key bugs in `PhaseTracker` that may be adjacent to (or the same as) the US3 re-cycle.
- Field resolution log: closed #1041 as spurious; admin-squash-merged #1039 after CI flake cleared. Filed via `/cockpit:auto` during epic `generacy-ai/generacy-cloud#850` P5.

---

*Generated by speckit; enhanced from GitHub issue #1043.*
