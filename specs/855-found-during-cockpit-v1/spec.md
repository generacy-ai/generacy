# Feature Specification: `gh pr checks --json` requests nonexistent fields — merge hard-fails; status/watch checks have silently never worked

**Branch**: `855-found-during-cockpit-v1` | **Date**: 2026-07-08 | **Status**: Draft

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #20 — first hard failure of a defect that has silently degraded every checks-dependent surface since rev 2.

**Observed**: `generacy cockpit merge 2` (after #853's workaround) exits 1 with `gh pr checks failed (exit 1): Unknown JSON field: "conclusion"`.

**Root cause**: `packages/cockpit/src/gh/wrapper.ts:605` requests `--json name,state,conclusion,detailsUrl` from `gh pr checks` — TWO of those fields have never existed on that command. `gh pr checks --json` exposes: `bucket, completedAt, description, event, link, name, startedAt, state, workflow` (verified on gh 2.96.0). `conclusion` is REST / `gh run` vocabulary; the URL field is `link`, not `detailsUrl`. gh validates the `--json` field list CLIENT-SIDE before any network call, so this method has failed on every gh version, every invocation, since it was written.

**Blast radius**:
- `merge`'s checks branch — hard failure, blocks every merge on a red-or-pending-checks path.
- `context`'s implementation-review bundle and review-context-json (checks section) — silent degradation.
- `status` and `watch` checks rollups — silent degradation. Explains a week-old observation that every `cockpit status` render during the smoke test showed blank checks columns (`- / none`) on every PR. That wasn't absent data; the fetch has never succeeded and the consumers degrade silently. The silent-degradation half deserves a warn log where the wrapper error is swallowed.

**Why tests never caught it**: the wrapper is exercised via mocked `CommandRunner` fixtures that answer with the shape the code EXPECTS — the same tests-encode-the-assumption pattern as #800/#826/#836/#853, but this time the drifted interface is gh's, not ours.

**Repro**: `gh pr checks 999 --repo <any> --json conclusion` → "Unknown JSON field" instantly, no auth needed.

## User Stories

### US1: Cockpit `merge` completes on checks-gated PRs

**As a** cockpit operator running `generacy cockpit merge <ref>`,
**I want** the checks-status branch of the merge flow to succeed,
**So that** a PR whose checks are green (or a fixer-cycle is legitimately warranted on red) actually merges instead of hard-failing on a malformed `gh` invocation.

**Acceptance Criteria**:
- [ ] `generacy cockpit merge <ref>` no longer exits 1 with `Unknown JSON field: "conclusion"`.
- [ ] Rollup states (pass / fail / pending / skipping / cancel) are derived from `gh pr checks`'s `bucket` field.
- [ ] A merge against a PR with all-green checks proceeds to the merge step.
- [ ] A merge against a PR with red checks routes to the existing fixer-subagent path (behavior unchanged).

### US2: `cockpit status` and `cockpit watch` render real check state

**As a** cockpit operator watching an epic,
**I want** the checks column in `status` and `watch` to reflect actual PR check state,
**So that** I can see red/pending/green at a glance instead of a blanket `- / none` that hides real signal.

**Acceptance Criteria**:
- [ ] `cockpit status` populates the checks column with per-PR rollups derived from `bucket`.
- [ ] `cockpit watch` state transitions reflect real check state changes.
- [ ] The silent-swallow path in the wrapper caller emits a `warn`-level log on failure so the next drift is loud, not silent.

### US3: `cockpit context` implementation-review bundle carries real checks data

**As a** reviewer consuming `cockpit context`'s implementation-review bundle or `review-context-json`,
**I want** the checks section to contain real per-check state and links,
**So that** review context is accurate instead of empty.

**Acceptance Criteria**:
- [ ] The checks section of the implementation-review bundle is populated (name, state, bucket, link).
- [ ] `review-context-json` output includes real check data.
- [ ] Consumers reference `link` (not `detailsUrl`) for the check's URL.

### US4: gh `--json` field drift is caught by CI, not by users

**As a** maintainer of the cockpit `gh` wrapper,
**I want** CI to fail fast if any `gh <cmd> --json <fields>` field list drifts away from what the pinned `gh` binary accepts,
**So that** the entire "gh interface drift invisible to mocked tests" class of bugs is closed for every wrapper method at once.

**Acceptance Criteria**:
- [ ] A CI-tier test runs the REAL pinned `gh` binary with each `--json` field list the codebase uses against a dummy ref.
- [ ] The test asserts no `Unknown JSON field` error appears in stderr for any field list.
- [ ] The test requires no auth and no network (relies on gh's client-side field validation).
- [ ] Adding a new `--json` call in the wrapper is automatically covered without a per-method test.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `getPullRequestCheckRuns` (`wrapper.ts:597`) MUST request `--json name,state,bucket,link` (not `name,state,conclusion,detailsUrl`). | P1 | Root fix. |
| FR-002 | The `CheckRunSummary` Zod schema MUST replace `conclusion` with `bucket` and `detailsUrl` with `link`, accepting the documented `bucket` values (`pass`, `fail`, `pending`, `skipping`, `cancel`). | P1 | `bucket` is purpose-built for the status rollup. |
| FR-003 | The rollup logic that today reads `conclusion` MUST map from `bucket` for the aggregated per-PR checks state used by `merge`, `status`, `watch`, and `context`. | P1 | Purpose-built for exactly this rollup. |
| FR-004 | All wrapper-consumer sites in `context.ts` and the `review-context-json` producer MUST be updated to read `bucket`/`link` instead of `conclusion`/`detailsUrl`. | P1 | Compilation must fail if a caller is missed. |
| FR-005 | Any caller that swallows the wrapper's error (i.e., today's silent-degradation site behind `status`/`watch`/`context` blank rollups) MUST emit a `warn`-level log on failure with enough context (repo, PR number, gh stderr) to diagnose future drift. | P1 | Closes the silent-degradation half of the defect. |
| FR-006 | A CI-tier test MUST invoke the real pinned `gh` binary with each `--json` field list in `packages/cockpit/src/gh/wrapper.ts` against a dummy ref and assert no `Unknown JSON field` error appears in stderr. | P1 | Covers all 13 `--json` sites in the wrapper. Deterministic; no auth or network required. |
| FR-007 | The CI-tier drift test MUST enumerate `--json` field lists via static extraction (grep or AST scan) so newly added wrapper methods are automatically covered. | P2 | Prevents regression of "we forgot to add a test for the new method." |
| FR-008 | A one-time grep pass MUST validate every other `--json` field list in the wrapper against the pinned `gh` binary's accepted fields; any drift found MUST be fixed in this feature branch. | P1 | 12 other `--json` sites at lines 519, 539, 619, 634, 655, 693, 750, 821, 892, 920, 1024, 1083. |
| FR-009 | Existing mock-based unit tests for `getPullRequestCheckRuns` MUST be updated to return the new shape (`bucket`, `link`) so they continue to reflect current wrapper contract. | P2 | Keep unit-test signal; don't leave stale fixtures. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `generacy cockpit merge <ref>` no longer aborts with `Unknown JSON field: "conclusion"`. | 0 occurrences | Run merge against a checks-having PR; verify exit 0 (green) or fixer-path entry (red). |
| SC-002 | `cockpit status` checks columns populated on PRs that actually have checks. | Non-`- / none` values shown for every PR with checks | Run `cockpit status` against a real epic during smoke test; visually verify. |
| SC-003 | CI drift test catches an intentionally malformed `--json` field list. | Test fails locally when a bogus field is injected into any wrapper `--json` call. | Add a temporary bogus field, run CI test, revert. |
| SC-004 | All 13 `--json` field lists in `wrapper.ts` are verified against the pinned `gh` binary. | 13/13 pass | CI test output enumerates all covered call sites. |
| SC-005 | Silent-swallow paths now log a `warn` on wrapper failure. | 1 log line per swallowed failure | Inject a wrapper failure in a test env; observe warn log. |

## Assumptions

- The pinned `gh` version used in CI exposes the fields listed in the issue: `bucket, completedAt, description, event, link, name, startedAt, state, workflow`. Verified on gh 2.96.0.
- `bucket` values `pass | fail | pending | skipping | cancel` are stable across the gh versions we support and semantically map onto the existing rollup states used by `merge`/`status`/`watch`.
- The consumers `context.ts` and `review-context-json` reference `conclusion`/`detailsUrl` from a typed schema, so the rename will surface as compile errors and not silently miss a caller.
- CI runners have the pinned `gh` binary available (drift test relies on this).
- gh's client-side `--json` field validation runs before any network/auth, so the drift test needs neither.

## Out of Scope

- Broader "test-mock-drift" hardening for non-`gh` external interfaces (e.g., Anthropic SDK, Firebase). This feature narrowly closes the gh-drift class.
- Refactoring the wrapper's overall shape (e.g., splitting per-command modules).
- Introducing a new abstraction for command execution or a mock-fixture-freshness system beyond the specific CI drift test described.
- Backporting the fix to older release branches (not applicable — cockpit v1 is on main development line).
- Changes to any `--json` field list outside `packages/cockpit/src/gh/wrapper.ts` (verified in FR-008 pass; if drift exists elsewhere, that is a follow-up).

---

*Generated by speckit*
