# Feature Specification: `cockpit merge` reads `completed:validate` from the linked issue (labels are issue-scoped) and blocks CLOSED issues

**Branch**: `853-found-during-cockpit-v1` | **Date**: 2026-07-08 | **Status**: Draft
**Source**: [generacy-ai/generacy#853](https://github.com/generacy-ai/generacy/issues/853) — cockpit v1 integration smoke test finding #19, first live run of `cockpit merge` on `christrudelpw/sniplink#2`.

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #19 — first live run of `cockpit merge`.

Observed: `christrudelpw/sniplink#2` carries `completed:validate` (validate passed). `generacy cockpit merge christrudelpw/sniplink#2` resolved the linked PR #16, then returned `{"status":"red","reason":"missing-label"}` — because `merge.ts:56` checks `pr.labels` for `completed:validate`. Workflow labels are **issue-scoped** (label protocol; #807 Q2 decision: "the orchestrator writes waiting-for/completed on issues"); nothing syncs them to PRs, so the missing-label branch fires for EVERY PR on every epic — merge can never succeed.

Fix: check the linked **issue's** labels for `completed:validate` (the verb already has the issue ref in hand before resolving the PR); keep the rest of the decision tree (required checks green → squash; red → failing-check JSON) on the PR where it belongs. The missing-label error copy should name the issue ref it inspected.

Note: unit tests presumably labeled the PR fixture directly — same tests-encode-the-bug pattern as #800/#826/#836. The regression test below is the counterexample fixture.

Interim workaround applied on the test project: manually adding `completed:validate` to the PR to satisfy the current check, so the remaining merge path (checks rollup → squash) still gets exercised.

## User Stories

### US1 — `cockpit merge` succeeds when the linked issue carries `completed:validate`

**As an** operator running `generacy cockpit merge <owner/repo#N>`,
**I want** the label check to read `completed:validate` from the linked **issue**, not the PR,
**So that** the merge verb works against the issue-scoped label protocol and doesn't fail with `missing-label` on every epic.

**Acceptance Criteria**:
- [ ] `cockpit merge <issue-ref>` on an epic whose linked PR is unlabeled but whose **issue** carries `completed:validate` and whose required PR checks are green squash-merges the PR to `develop`.
- [ ] `cockpit merge <issue-ref>` on an epic whose **issue** does not carry `completed:validate` returns `{status:"red", reason:"missing-label", pr:{...}, issue:{...}}` and exits non-zero — the payload additively carries the issue ref alongside the existing non-null `pr` field.
- [ ] The existing PR-scoped decision tree (required checks green → squash; red checks → `failing-check` JSON) is unchanged — those still read from the PR.

### US2 — `missing-label` error copy names the issue ref that was inspected

**As an** operator diagnosing a `missing-label` failure,
**I want** the failing-check JSON (and stderr line) to name the issue ref whose labels were checked,
**So that** I know exactly which issue needs the `completed:validate` label — not just "some PR's labels."

**Acceptance Criteria**:
- [ ] The `missing-label` payload includes both refs: `pr: {owner, repo, number}` (existing) and `issue: {owner, repo, number}` (new, additive).
- [ ] The stderr line names the issue ref (e.g., `cockpit merge: missing completed:validate on issue owner/repo#N`).
- [ ] No consumer of the existing `pr` field breaks — the field remains non-null on `missing-label`.

### US3 — `cockpit merge` refuses to merge when the linked issue is CLOSED

**As an** operator whose merge verb is the last human-gated step before an irreversible squash to `develop`,
**I want** `cockpit merge` to refuse when the linked issue is `CLOSED` (regardless of `stateReason`),
**So that** an issue closed as a duplicate, closed manually, or auto-closed by an unrelated PR never silently produces a merge, and the deliberate override is "reopen the issue."

**Acceptance Criteria**:
- [ ] `cockpit merge <issue-ref>` on a `CLOSED` issue returns red with the issue state and `stateReason` in the payload/stderr and does not squash-merge — even if the PR is OPEN with green checks and the issue carries `completed:validate`.
- [ ] The OPEN-issue path is unchanged: an OPEN issue with `completed:validate` + OPEN PR + green checks still merges.
- [ ] The operator can override by reopening the issue and re-running `cockpit merge`.

## Clarifications

### Session 2026-07-08

- **Q1 → B**: Issue-label check runs **after** PR resolution (current order). The `missing-label` payload keeps its non-null `pr` invariant and additively gains an issue ref field so operators see both refs. Rationale: the fail-fast saving (A) is one gh call on the failure path only — irrelevant — while relaxing `pr` to `null` changes a payload invariant the cockpit plugin's decision table was written against.
- **Q2 → B**: If the issue-label fetch throws (404 / repo mismatch / network / malformed JSON), `runMerge` returns `{status:"red", reason:"unresolved", pr:null, issue:{...}}` — reusing the existing `unresolved` reason with the issue ref included. The raw gh error still goes to stderr. Rationale: `unresolved` is semantically exact ("couldn't get far enough to check") and keeps the reason vocabulary closed. `getPullRequestDetail` bubbling remains the general gh-error path for now; a full taxonomy is a separate cleanup.
- **Q3 → A**: `runMerge` refuses to merge when the issue is `CLOSED`, mirroring the existing PR-OPEN guard. The payload/stderr names the issue state and `stateReason`. Rationale: cost asymmetry — wrongly blocking costs a human ten seconds (reopen the issue, which doubles as the deliberate override), while wrongly merging is an unwanted squash to `develop`. Option C's `stateReason` discrimination silently merges the closed-as-completed-with-open-PR anomaly, which the merge gate must never resolve silently toward merge.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                                                                                                                                 | Priority | Notes                                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| FR-001 | `runMerge` MUST read the `completed:validate` label from the **linked issue's** labels, not the PR's. The existing `pr.labels` read at `packages/generacy/src/cli/commands/cockpit/merge.ts:56` MUST be replaced with a fetch against the issue that the CLI already has in hand from `resolveIssueContext`. | P0       | Root cause — labels are issue-scoped per the #807 label protocol.              |
| FR-002 | The issue-label check MUST run **after** PR resolution (current order: `resolveIssueToPRRef` → OPEN check → `getPullRequestDetail` → issue-label check). The `missing-label` failing-check payload MUST retain its non-null `pr` invariant.                                                                  | P0       | Q1=B; preserves the cockpit plugin's decision-table contract.                   |
| FR-003 | The `missing-label` and `unresolved` failing-check payloads MUST additively include an `issue: {owner, repo, number}` field naming the issue whose labels were inspected (or that could not be fetched). The stderr line MUST name the issue ref.                                                            | P0       | Additive — no existing consumer breaks.                                        |
| FR-004 | If the issue-label fetch throws (issue not found, repo mismatch, gh CLI network/auth failure, malformed JSON), `runMerge` MUST return `{status:"red", reason:"unresolved", pr:null, issue:{...}}` and exit non-zero. The raw gh error message MUST still be written to stderr.                               | P0       | Q2=B; reuses the existing `unresolved` reason — no new enum value.              |
| FR-005 | `runMerge` MUST refuse to merge when the linked issue is `CLOSED` (regardless of `stateReason`). The response MUST be red with `issue.state` and `issue.stateReason` named in the payload and the stderr line. The existing PR-OPEN guard is unchanged.                                                       | P0       | Q3=A; symmetric with the PR-OPEN guard; cost asymmetry favors block-by-default. |
| FR-006 | The remainder of the merge decision tree (required checks rollup: green → squash-merge; red → `failing-check` JSON) MUST remain PR-scoped and MUST NOT change behavior for any of these paths.                                                                                                              | P0       | Fix scope is strictly the label-source and CLOSED-issue guard.                  |
| FR-007 | A regression test MUST cover: (a) issue labeled `completed:validate` + PR unlabeled + PR checks green → merge succeeds; (b) issue unlabeled + PR labeled with `completed:validate` → returns `missing-label` with the ISSUE ref in the payload; (c) issue `CLOSED` + everything else green → red with issue state. | P0       | Counterexample fixture for the tests-encode-the-bug pattern (#800/#826/#836).   |
| FR-008 | Existing unit tests that assert `completed:validate` on a PR fixture as a merge precondition MUST be updated (or removed) to reflect the issue-scoped label protocol. Tests that assert PR-labels for `completed:validate` MUST NOT remain green after the fix.                                                | P1       | Prevents the tests from re-encoding the same bug.                              |

## Success Criteria

| ID     | Metric                                                                                                             | Target                            | Measurement                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| SC-001 | `cockpit merge` on an epic with `completed:validate` on the issue and green PR checks squash-merges to `develop`.  | 100% (0 false-red)                | Repro on `christrudelpw/sniplink#2` (or equivalent); assert `merge` exits 0 and the PR is closed as merged.       |
| SC-002 | `cockpit merge` on an epic without `completed:validate` on the issue returns `missing-label` with the ISSUE ref.   | 100%                              | Unit test on the `missing-label` branch; assert payload shape includes `issue: {...}`.                             |
| SC-003 | `cockpit merge` on a `CLOSED` issue does not merge and includes `state`/`stateReason` in the payload.               | 100%                              | Unit test on the closed-issue branch; assert non-zero exit + payload fields.                                       |
| SC-004 | No unit test in the repo asserts `completed:validate` on a PR fixture as a merge precondition.                     | 0 tests                           | Grep the test corpus; the counterexample regression fixture (FR-007b) is the only remaining shape.                 |
| SC-005 | The existing PR-scoped decision tree (checks rollup → squash / red → `failing-check`) is unchanged.                 | 0 regressions                     | Existing `merge.test.ts` cases pass without behavioral edits (except FR-008 fixture updates).                     |

## Assumptions

- The gh CLI wrapper (`packages/cockpit/src/gh/wrapper.ts`) already exposes (or will trivially expose) a way to fetch an issue's labels + `state` + `stateReason` for the linked issue. No investigation of a new gh API surface is in scope beyond a `fetchIssueLabels`/`getIssue` call.
- The linked issue ref is already resolvable from the input `<owner/repo#N>` via `resolveIssueContext` before any PR-side gh call — no new resolution logic is needed to know *which* issue's labels to check.
- The `completed:validate` label semantics are unchanged: the orchestrator continues to write `completed:validate` on the **issue** (not the PR) when validate passes (#807 Q2 decision).
- Consumers of the `failing-check` JSON payload treat `issue: {...}` as additive (they either ignore unknown fields or the payload schema is extended in lockstep in a follow-up).
- Reopening a `CLOSED` issue is the operator's deliberate override to unblock merge — no CLI flag override is needed for v1 of this fix.

## Out of Scope

- General gh-error taxonomy for `runMerge` (e.g., structuring `getPullRequestDetail` failures the same way as FR-004). Q2 rationale explicitly defers this — a separate cleanup, not this bugfix.
- Adding a `--force` / `--allow-closed-issue` CLI flag to override the CLOSED-issue guard. Operator reopens the issue instead (Q3 rationale).
- Syncing `completed:*` / `waiting-for:*` labels from issue to PR. The fix explicitly embraces the issue-scoped label protocol; PR-side labels for workflow gates are not maintained.
- Changing the `failing-check` reason vocabulary beyond adding the `issue` field to the payload (no new `RedReason` enum values).
- Cockpit plugin (cross-repo) changes to render the new `issue` payload field. Additive on this side; cockpit plugin picks it up as-is or ignores it until it opts in.
- Documentation updates beyond the changelog / merge command help text — the label protocol doc already lives in the cockpit plugin repo (`merge.md`).

---

*Generated by speckit*
