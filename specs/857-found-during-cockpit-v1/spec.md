# Feature Specification: cockpit merge conflates "no checks reported" with check failure — CI-less repos can never merge; treat absence per required-checks authority

**Branch**: `857-found-during-cockpit-v1` | **Date**: 2026-07-08 | **Status**: Draft

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #22 — surfaced immediately after #855's fix, one step deeper into the merge path.

Observed: `generacy cockpit merge 2` on christrudelpw/sniplink#2 (PR #16) fails with `gh pr checks failed (exit 1): no checks reported on the '002-phase-1-foundation-part' branch`. The repo has no CI configured — `gh pr checks` exits 1 for BOTH "checks failed" and "no checks exist", and the wrapper's failIfNonZero conflates them, so a CI-less repo can never merge. (The structured `{repo, prNumber, ghStderr}` error shape from #855's FR-005 made this diagnosis trivial — working as designed.)

Fix — absence is not failure; requiredness is the authority:

1. **Wrapper**: `getPullRequestCheckRuns` recognizes gh's no-checks case (exit 1 + stderr matching `no checks reported`) and returns an EMPTY check-run list instead of throwing. All other non-zero exits keep throwing.
2. **Merge decision**: with the empty list, evaluate against the required-checks set (branch protection, already fetched with the PR-check-list fallback):
   - required set empty + nothing reported → **vacuously green** → proceed to squash, emitting an explicit stdout note ("no checks configured and none required — proceeding on completed:validate") so the condition is visible, never silent
   - required set NON-empty + contexts absent → **red**, reason naming the missing required contexts (absent-required is a real block, not vacuous green)
3. **status/watch rollups**: empty list renders as the existing `'none'` value — which becomes legitimate data rather than the degrade case.

Rationale: the merge invariant is "never merge on RED" — no-checks is not red. `completed:validate` is the workflow's own quality gate and remains mandatory; teams that want CI mandatory express it via branch-protection required checks, which the verb continues to respect.

Live repro: christrudelpw/sniplink PR #16 (issue #2 fully validated, zero CI configured) — the exact terminal state of the smoke test's first end-to-end issue.

## User Stories

### US1: Merge a CI-less repo with completed:validate

**As a** cockpit operator running `generacy cockpit merge <ref>` against a repo with no CI configured,
**I want** the merge to succeed when the issue carries `completed:validate` and branch protection defines no required checks,
**So that** the workflow's own quality gate is honored and the CI-less repo class stops being permanently unmergeable.

**Acceptance Criteria**:
- [ ] `generacy cockpit merge <issue>` on a PR whose repo has zero CI configured and no branch-protection required checks completes the squash merge.
- [ ] On the vacuously-green path, the command emits an explicit stdout note reading exactly `no checks configured and none required — proceeding on completed:validate` before the merge is issued.
- [ ] Exit code is 0 on the vacuous-green path.

### US2: Absent required checks still block merge

**As a** cockpit operator running `generacy cockpit merge <ref>` against a repo whose branch protection lists required contexts,
**I want** the merge to be refused (red) when those required contexts have never reported,
**So that** "no checks reported" is not silently upgraded to green when the branch-protection authority explicitly names required contexts.

**Acceptance Criteria**:
- [ ] When `getRequiredCheckNames` returns `source: 'branch-protection'` with a non-empty `names` list and `getPullRequestCheckRuns` returns `[]`, the merge exits 1 with the existing `checks-failing` JSON envelope.
- [ ] The `failingChecks` array names every required context with `state: 'MISSING'`.
- [ ] No merge API call is issued.

### US3: status/watch checks column reflects "no checks" as legitimate data

**As a** cockpit operator running `generacy cockpit status` (or `watch`) over an epic that includes CI-less repos,
**I want** the checks column to render `none` for PRs with zero configured checks,
**So that** the display distinguishes "no CI here" from "checks pending" without triggering the wrapper's error-degrade path.

**Acceptance Criteria**:
- [ ] For a PR whose repo has no CI, the checks rollup in `cockpit status` shows `none` (not `pending`, not `failure`, not an error line).
- [ ] For a PR whose repo has no CI, the checks column in `cockpit watch` renders the same `none` value.
- [ ] The `getPullRequestCheckRuns` warn-log added in #855's FR-005 does NOT fire on the no-checks case (it is not an error).

### US4: Non-"no checks reported" gh failures still throw

**As a** contributor debugging a genuine gh failure (auth revoked, network down, malformed args),
**I want** the wrapper to keep throwing on every non-zero exit that is not the "no checks reported" case,
**So that** real failures stay loud and the fix does not swallow errors that belong to other exit conditions.

**Acceptance Criteria**:
- [ ] `getPullRequestCheckRuns` throws when `gh pr checks` exits non-zero and stderr does not match the no-checks-reported pattern.
- [ ] The existing `{ repo, prNumber, ghStderr }` warn log continues to fire on those genuine-failure paths.
- [ ] A test asserts that a synthetic exit-1 with unrelated stderr still throws.

## Functional Requirements

| ID  | Requirement | Priority | Notes |
|-----|-------------|----------|-------|
| FR-001 | `getPullRequestCheckRuns` in `packages/cockpit/src/gh/wrapper.ts` MUST detect the no-checks-reported case by matching `result.exitCode === 1` AND stderr matching `/no checks reported/i` (or equivalent gh-emitted phrase), and return `[]` instead of throwing. | P1 | Root fix. Pattern must match the exact stderr gh emits on 2.96.x for a branch with zero configured checks. |
| FR-002 | On the FR-001 no-checks path, `getPullRequestCheckRuns` MUST NOT emit the `warn`-level log added in #855 FR-005. Genuine failures still log and rethrow as today. | P1 | The no-checks path is not an error; logging it as one would re-create the noise the fix was meant to silence. |
| FR-003 | `runMerge` in `packages/generacy/src/cli/commands/cockpit/merge.ts` MUST proceed to `mergePullRequest` when `classifyChecks({ required, actual: [] })` returns `ok: true` (i.e. required set empty AND actual empty), emitting to stdout the exact line `no checks configured and none required — proceeding on completed:validate\n` before the merge call. | P1 | Visible-not-silent per summary. Line format is fixed so scrapers can grep for it. |
| FR-004 | When `getRequiredCheckNames` returns `source: 'branch-protection'` with a non-empty `names` list and `getPullRequestCheckRuns` returns `[]`, `classifyChecks` MUST report each required name as `state: 'MISSING'` and `ok: false`, and `runMerge` MUST refuse the merge via the existing `checks-failing` JSON envelope. | P1 | Absent-required is a real block. Existing `classifyChecks` already emits `MISSING` for the branch-protection path; the invariant is that this behavior survives the wrapper change. |
| FR-005 | When `getRequiredCheckNames` returns `source: 'fallback-pr-checks'` (i.e. the token cannot read branch protection) AND `getPullRequestCheckRuns` returns `[]`, `runMerge` MUST take the same vacuous-green path as FR-003 (empty required + empty actual → proceed with the stdout note). | P1 | Fallback authority is "the PR's own check list"; if that list is empty, the fallback set is empty too, so vacuous-green is consistent. |
| FR-006 | The status/watch rollup helper (`packages/generacy/src/cli/commands/cockpit/watch/check-rollup.ts::rollup`) MUST return `'none'` (not `'pending'`) for an empty `CheckRunSummary[]` input, so `cockpit status` and `cockpit watch` render the no-checks case as `none`. | P1 | Aligns the rollup with the summary's "empty list renders as the existing 'none' value" contract. The type union already includes `'none'` at the callsite; the rollup helper must widen its return type to match. |
| FR-007 | The `ChecksRollup` type MUST include `'none'` as a first-class variant returned by `rollup([])`, and every consumer of `rollup()` in the status/watch surface MUST accept `'none'` without falling through to the catch/degrade branch. | P1 | Type-level guarantee that `'none'` cannot be silently coerced back to `'pending'`. |
| FR-008 | The `rollup([])` → `'none'` change MUST NOT alter the semantics of a non-empty list containing only PENDING checks; those still return `'pending'`. | P1 | Prevents the fix from bleeding into the genuine-in-flight-checks case. |
| FR-009 | A regression test in `packages/cockpit/src/__tests__/gh-wrapper.test.ts` MUST assert that `getPullRequestCheckRuns` returns `[]` when `runner` yields `{ exitCode: 1, stderr: "no checks reported on the '<branch>' branch\n" }`. | P1 | Repro-shape test; blocks any future edit that reintroduces the throw path. |
| FR-010 | A regression test MUST assert that `getPullRequestCheckRuns` still throws when `runner` yields `{ exitCode: 1, stderr: "<any other message>" }` and that the warn log fires on that path. | P1 | Guards US4: genuine failures still loud. |
| FR-011 | A regression test in `packages/generacy/src/cli/commands/cockpit/__tests__/` MUST cover the vacuous-green path end-to-end: fake gh returns empty required + empty actual, `runMerge` calls `mergePullRequest`, exit is 0, stdout contains the exact FR-003 note. | P1 | End-to-end proof for US1. |
| FR-012 | A regression test MUST cover the absent-required-blocks path: fake gh returns `source: 'branch-protection'` with non-empty `names` + empty actual, `runMerge` exits 1 without calling `mergePullRequest`, and the emitted `checks-failing` payload's `failingChecks` names every required context with `state: 'MISSING'`. | P1 | End-to-end proof for US2. |

## Success Criteria

| ID  | Metric | Target | Measurement |
|-----|--------|--------|-------------|
| SC-001 | `generacy cockpit merge <issue>` against a CI-less unprotected repo with `completed:validate` set. | Exits 0, squash-merges, emits the FR-003 stdout note. | Manual repro against christrudelpw/sniplink PR #16 (live repro cited in the summary). |
| SC-002 | `generacy cockpit merge <issue>` against a repo whose branch protection lists required contexts, with no runs reported. | Exits 1 with `checks-failing` envelope; `failingChecks[*].state` is `'MISSING'` for every required context. | Vitest end-to-end (FR-012). |
| SC-003 | `generacy cockpit merge <issue>` against a repo with failing check runs. | Behavior UNCHANGED from today — exits 1 with `checks-failing`, feeds the fixer path. | Vitest regression already present (should remain green). |
| SC-004 | `cockpit status` / `watch` on a CI-less PR. | Checks column renders `none`. | Vitest for `rollup([]) === 'none'` (FR-006) plus a status-render fixture where the fake gh returns `[]`. |
| SC-005 | Silent-swallow safety. | Zero occurrences of `getPullRequestCheckRuns` swallowing a non-`no-checks-reported` error. | Regression test (FR-010) asserts throw + warn on unrelated stderr. |
| SC-006 | Stdout note discoverability. | The vacuous-green path's stdout line is `no checks configured and none required — proceeding on completed:validate`, byte-exact. | grep-based assertion in FR-011 test. |

## Assumptions

- gh 2.96.x emits `no checks reported on the '<branch>' branch` on stderr with exit code 1 when no check runs exist for a PR. Case-insensitive substring match on `no checks reported` is sufficient to detect this condition without pinning to the branch-name suffix format.
- `classifyChecks` already emits `state: 'MISSING'` for each required-by-branch-protection name absent from the actuals; no change to `classifyChecks` is required beyond confirming the empty-actuals branch of the branch-protection path behaves as designed.
- `getRequiredCheckNames`'s `source: 'fallback-pr-checks'` behavior means the fallback set is populated from the PR's own check list; if that list is empty, the fallback set is empty, so `classifyChecks({ required: { source: 'fallback-pr-checks', names: [] }, actual: [] })` returns `ok: true` today (iteration over `actual` is empty).
- No consumer of `rollup()` in status/watch relies on `pending` as the empty-list marker; all callsites either default to `'none'` above the `rollup()` call (as `status.ts` does today) or accept a widened return type without regressing render behavior.
- The FR-003 stdout note format ("no checks configured and none required — proceeding on completed:validate") is fine to introduce as new stdout because no existing scraper reads cockpit merge's non-JSON stdout on the green path (the JSON envelope is emitted only on the red path).

## Out of Scope

- Adding a CLI flag to force-merge on failing checks, or to override the `completed:validate` requirement.
- Changing `getRequiredCheckNames` (the required-set fetch and its `branch-protection` vs `fallback-pr-checks` sources are pre-existing and correct for this fix).
- Restructuring `FailingCheckPayload` or its `RedReason` union.
- Changing the `checks-failing` JSON envelope shape for the absent-required path (it reuses the existing `checks-failing` reason with `state: 'MISSING'` entries).
- Emitting a machine-readable envelope on the vacuous-green path; the note is human-readable stdout only.
- Extending the wrapper's exit-code parsing beyond the single `no checks reported` case; other gh error shapes remain hard-throws.

---

*Generated by speckit*
