# Feature Specification: `cockpit merge` — check `completed:validate` on the issue, not the PR

**Branch**: `853-found-during-cockpit-v1` | **Date**: 2026-07-08 | **Status**: Draft

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #19 — first live run of `cockpit merge`.

**Observed**: `christrudelpw/sniplink#2` carries `completed:validate` (validate passed). Running `generacy cockpit merge christrudelpw/sniplink#2` resolved the linked PR #16, then returned `{"status":"red","reason":"missing-label"}` — because `packages/generacy/src/cli/commands/cockpit/merge.ts:56` checks `pr.labels.includes('completed:validate')`. Workflow labels are issue-scoped by protocol (see #807 Q2 decision: "the orchestrator writes waiting-for/completed on issues"); nothing syncs them to PRs, so the `missing-label` branch fires for **every** PR on **every** epic — `cockpit merge` can never succeed on its own.

**Fix**: check the linked **issue's** labels for `completed:validate` (the verb already has the issue ref in hand before resolving the PR); keep the rest of the decision tree (required checks green → squash; red → `failing-check` JSON) on the PR where it belongs. The `missing-label` error copy must name the **issue** ref it inspected (not the PR).

**Interim workaround** applied on the test project: manually adding `completed:validate` to the PR to satisfy the current check, so the remaining merge path (checks rollup → squash) still gets exercised.

## User Stories

### US1: Cockpit merge succeeds on a validated epic

**As a** cockpit operator running `generacy cockpit merge <issue-ref>`,
**I want** the command to check that the **issue** carries `completed:validate` (not the PR),
**So that** a PR whose parent issue has passed validate is squash-merged when its required checks are green — without me having to hand-label the PR.

**Acceptance Criteria**:
- [ ] Given an issue labeled `completed:validate` and its linked PR with no such label, `cockpit merge` proceeds past the label check to the required-checks branch.
- [ ] Given an issue **not** labeled `completed:validate`, `cockpit merge` returns `{"status":"red","reason":"missing-label"}` with the payload naming the **issue** ref (owner/repo#issueNumber, or equivalent field surfaced by the failing-check JSON contract).
- [ ] Required-checks classification and squash-merge behavior on the PR are unchanged.
- [ ] Logs mention the issue ref when the label is missing (not the PR).

### US2: Regression fixture reflects the protocol

**As a** contributor maintaining `cockpit merge`,
**I want** the label-check regression test to label the **issue** fixture (not the PR fixture),
**So that** the test cannot pass by accidentally re-encoding the pre-fix bug (same tests-encode-the-bug pattern as #800/#826/#836).

**Acceptance Criteria**:
- [ ] New test: issue labeled `completed:validate` + PR unlabeled → merge proceeds to the checks branch (not `missing-label`).
- [ ] New test: issue **unlabeled** → `missing-label` payload includes the issue ref.
- [ ] Any pre-existing test that labeled the PR fixture to satisfy the label check is updated to label the issue fixture instead.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `runMerge` reads labels from the **issue** identified by `input.issue` + `input.repo`, not from the resolved PR. | P1 | Use existing `GhWrapper` methods (`getIssue` or `fetchIssueLabels` in `packages/cockpit/src/gh/wrapper.ts`). Do not add a new label sync path. |
| FR-002 | If the issue does not carry `completed:validate`, return exit 1 with the existing `failing-check` JSON shape and `reason: "missing-label"`. | P1 | Payload must identify the **issue** (not just the PR) so operators know what to label. Exact JSON shape refinement (add issue ref field vs. reuse existing) is a design choice for `/plan`. |
| FR-003 | The logger warning currently at `merge.ts:57-60` must reference the issue ref (not the PR number) when the label is missing. | P1 | Structured log fields updated accordingly. |
| FR-004 | Downstream behavior after the label check (required-checks lookup, `classifyChecks`, squash merge, `checks-failing` payload) is unchanged. | P1 | Scope-limiting requirement — no changes to required-check derivation, squash options, or unresolved/OPEN-state gating. |
| FR-005 | Regression tests exercise both branches with issue-scoped labeling: (a) issue-labeled + PR-unlabeled → checks branch; (b) issue-unlabeled → `missing-label` with issue ref. | P1 | See US2. |
| FR-006 | `packages/generacy/src/cli/commands/cockpit/merge.ts` command help text still accurately describes the gate ("iff it carries `completed:validate`") — no CLI-surface changes. | P2 | The `it` in the help text now unambiguously refers to the issue; may be reworded for clarity but not required. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `cockpit merge` succeeds end-to-end without hand-labeling the PR. | 100% of PRs whose parent issue carries `completed:validate` and required checks are green | Re-run the tetrad-development#88 smoke against a fresh sniplink PR; observe squash-merge without the interim workaround. |
| SC-002 | `missing-label` payload identifies the issue. | Every `missing-label` JSON emission includes an issue ref field | Unit test + smoke-test JSON inspection. |
| SC-003 | Regression tests fail if `merge.ts` reverts to reading `pr.labels`. | Both US2 tests fail on a revert | Introduce the two tests in this PR; verify they detect a stubbed revert of `merge.ts:56`. |
| SC-004 | No new `gh` calls added beyond what's needed to fetch issue labels. | Diff shows only substitution of PR-label read with issue-label read | Code review. Prevents scope creep into a general "sync labels to PRs" feature. |

## Assumptions

- The `GhWrapper` already exposes an issue-label read path (`getIssue` and/or `fetchIssueLabels` per `packages/cockpit/src/gh/wrapper.ts`). Confirmed in code.
- The `failing-check` JSON contract (`packages/generacy/src/cli/commands/cockpit/shared/failing-check-json.ts`) tolerates a small additive change to include an issue ref, or already surfaces enough context. `/plan` will confirm the exact field.
- No cloud-side change is needed — the fix is entirely in `packages/generacy` + tests.
- `resolveIssueContext` already yields the canonical issue ref (`ctx.ref.number` + `ctx.repo`) before PR resolution — no new resolver work is required.

## Out of Scope

- Syncing workflow labels from issues to PRs (a distinct architectural choice; #807 Q2 decision explicitly places these labels on issues).
- Any change to `waiting-for:*` label semantics, orchestrator label writer behavior, or the label protocol itself.
- Changes to required-check derivation, `fallback-pr-checks` warning, squash options, or `unresolved`/non-OPEN handling.
- A general refactor of `merge.ts` beyond the label-check substitution and its error/log copy.
- Cloud-side or cockpit-web surface changes (this is CLI-only).

---

*Generated by speckit*
