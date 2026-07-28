# Implementation Plan: Prevent worker from resurrecting deleted branches and cross-contaminating issues after PR merge

**Feature**: Bundle four independent orchestrator-worker fixes that stop a re-entering worker from resurrecting a merged-and-deleted branch, silently committing another issue's files onto it, and opening a duplicate PR that claims to close the already-closed issue.
**Branch**: `1051-problem-after-speckit-pr`
**Status**: Complete
**Issue**: [#1051](https://github.com/generacy-ai/generacy/issues/1051)

## Summary

`generacy-ai/generacy-cloud#883` (evidence in `spec.md`) exposed a compose of three latent defects in `packages/orchestrator/src/worker/`:

1. **Un-pruned fetch** at `repo-checkout.ts:109` (`switchBranch`) and `:224` (`updateRepo`) leaves deleted upstream branches locally resolvable; the subsequent `git checkout <branch>` at `:112` / `:228` silently succeeds against the stale local ref, the "Local branch not found" fallback at `:114` / `:230` never fires, and `reset --hard origin/<branch>` restores the pre-merge tip.
2. **Blind push** in `pr-feedback-handler.ts:670` (mirrored by the phase-commit path in `pr-manager.ts:114`) pushes with no check that the PR is still open or the remote branch still exists — silently recreating the branch and opening a duplicate PR that claims `Closes #<N>` for an already-closed issue.
3. **Reused checkout carrying another issue's working tree** (`repo-checkout.ts:14,:35` — bootstrapped-repo reuse across issues). When re-entered dirty, `git reset --hard HEAD` + `git clean -fd` clean **committed / tracked** state but the phase-run step re-emits per-issue files into the working tree; the observed commit `d8e392ca` contained #880's files onto #879's branch.
4. **No dispatch gate for closed issues** — a `resume` event fired on the already-closed #879 sailed through `LabelMonitorService.processLabelEvent()` and reached the git layer. #1049 gated `PrFeedbackMonitorService` but the observed field failure was a phase re-entry (`type === 'resume'`), not a feedback cycle.

Fix shape: four independent, additive changes, all in `packages/orchestrator/src/worker/` and `packages/orchestrator/src/services/`, backed by one new helper in `packages/workflow-engine/src/actions/github/client/`.

- **FR-001** — add `--prune` to `git fetch origin` at `repo-checkout.ts:109` and `:224`. `fetchBase:143` is single-ref and unaffected.
- **FR-002 + FR-003** — introduce a stateless pre-push guard used at two invocation sites per phase (immediately after `switchBranch`, immediately before `commitPushAndEnsurePr` / `commitAndPushChanges`). Guard queries `--state all` for the head branch and `git ls-remote --heads origin <branch>` for remote-branch existence; refuses with a structured `event: 'push-refused'` warn log and the FR-003b label state (issue closed → clear `agent:in-progress`; issue open → clear `agent:in-progress` + add `agent:error`; never `failed:<phase>`).
- **FR-004** — before the phase step begins, and again immediately after `switchBranch`, invalidate the working tree so files from a prior issue's checkout re-entry cannot leak into the commit. Chosen implementation: reuse the existing `git reset --hard HEAD` + `git clean -fd` already performed inside `switchBranch` (`:106-107` and `:220-221`), promoted to be the sole allowed entry into phase work — no new subsystem, no per-issue checkout redesign. Regression test in `packages/orchestrator/src/__tests__/repo-checkout-cross-issue.test.ts`.
- **FR-005** — in `LabelMonitorService.processLabelEvent()`, drop `type === 'process'` **and** `type === 'resume'` jobs whose target issue is `closed` at the moment of dispatch. Piggyback on the already-loaded `fetchedIssue` (`label-monitor-service.ts:326`) where present; consult `github.getIssue(...).state` when absent. Emit one `info` log with `dropped: 'issue-closed'` + `{ issueNumber, eventType, phase }`. Zero mutations on drop.

## Technical Context

- **Language / runtime**: TypeScript / Node.js ≥22 (orchestrator + workflow-engine packages, both ESM).
- **Test framework**: `vitest` (`.test.ts` co-located with source under `__tests__/`).
- **Git surface used**: `execFile('git', ...)` via `node:child_process` (existing pattern in `repo-checkout.ts`). No new git binary features required.
- **GitHub surface used**: `gh` CLI via existing `GhCliGitHubClient` in `packages/workflow-engine/src/actions/github/client/gh-cli.ts`. One new method needed: `findPRForBranchAnyState(owner, repo, branch)` — mirrors `findPRForBranch` but passes `--state all`. Existing `findPRForBranch` MUST NOT be modified (five other call sites in `pr-manager.ts` × 2, `sibling-fanout.ts` × 2, and mocks depend on open-only default; see FR-002 clarification).
- **Log framework**: Pino, via existing `Logger` interface exposed to worker services. Structured `event: '<name>'` field convention already used at multiple sites (`comment-skipped`, `workflow-reentry-branch-mismatch`).
- **No new persisted state**: FR-007 explicitly forbids new Redis keys, files, or PR/issue markers. All checks are stateless queries against GitHub or the local git repo. Mirrors #1043 Q1=A rationale — avoids the stale-key/TTL class of bugs (#849).
- **Existing patterns leveraged**:
  - `execFileAsync('git', ['ls-remote', '--heads', 'origin', branch])` already used by `GhCliGitHubClient.branchExists(branch, true)` at `gh-cli.ts:1094-1097`.
  - `event: 'push-refused'` neutral name follows the existing `event: 'comment-skipped'` and `event: 'workflow-reentry-branch-mismatch'` convention.
  - `finally`-block clear of `agent:in-progress` already established at `pr-feedback-handler.ts:608-617` (#926 SC-004); FR-003b piggybacks on this pattern in the phase-loop path.
  - `#1043 Finding 1` two-callback dedup shape at `pr-manager.ts:238` proves that best-effort probes in `finally` do not disrupt normal flow — FR-003b's label mutation follows the same shape.
- **Scope discipline** (per spec §Out of Scope):
  - No cleanup of stranded duplicate PRs (existing `#883` is a manual fixup).
  - No changes to `PrFeedbackMonitorService`'s merged-PR gate (that is #1049 and shipped).
  - No per-issue checkout isolation subsystem — FR-004 chooses the minimal hard-reset variant.
  - No workflow-YAML changes (`speckit-feature.yaml`, `speckit-bugfix.yaml` untouched — FR-006).
  - No cross-repo topology changes (multi-repo #687/#690/#692 out of scope).
  - No new relay events for resurrection attempts.

## Project Structure

```
packages/orchestrator/src/
├── worker/
│   ├── repo-checkout.ts                       [MODIFIED] — FR-001: add `--prune` to two fetch sites
│   ├── pr-feedback-handler.ts                 [MODIFIED] — FR-002/003: pre-push guard call site
│   ├── pr-manager.ts                          [MODIFIED] — FR-002/003: pre-push guard on phase-commit path
│   ├── phase-loop.ts                          [MODIFIED] — FR-002 phase-start check after switchBranch
│   ├── push-guard.ts                          [NEW]      — FR-002/003: stateless PR-state + remote-branch check + refusal contract
│   └── __tests__/
│       ├── repo-checkout.test.ts              [MODIFIED] — SC-005: assert both fetch sites include `--prune`
│       ├── push-guard.test.ts                 [NEW]      — SC-002: 7-case decision matrix
│       └── pr-feedback-handler.push-guard.test.ts [NEW]  — SC-002: refusal path in pr-feedback-handler
├── services/
│   ├── label-monitor-service.ts               [MODIFIED] — FR-005: dispatch-time closed-issue gate
│   └── __tests__/
│       └── label-monitor-service.closed-issue.test.ts [NEW] — SC-004: process + resume drop paths
└── __tests__/
    ├── repo-checkout-cross-issue.test.ts      [NEW]      — SC-003: cross-issue working-tree contamination regression
    └── repo-checkout-branch-resurrection.integration.test.ts [NEW] — SC-001: merge-then-reenter cycle uses real git repo

packages/workflow-engine/src/actions/github/client/
├── gh-cli.ts                                  [MODIFIED] — add `findPRForBranchAnyState` mirroring `findPRForBranch` with `--state all`
├── interface.ts                               [MODIFIED] — declare `findPRForBranchAnyState` on `GitHubClient`
└── __tests__/
    └── gh-cli.find-pr-any-state.test.ts       [NEW]      — mocked-runner test for the new method

.changeset/
└── 1051-branch-resurrection-fix.md            [NEW]      — @generacy-ai/workflow-engine patch (new internal method, not re-exported at public boundary — SC-002 wire is orchestrator-only), @generacy-ai/orchestrator patch (bug fix, no new exports)
```

### Rationale for `push-guard.ts` as a new module

The guard has three distinct concerns (PR-state lookup, remote-branch check, refusal contract with label + log side-effects) that both `pr-feedback-handler.ts` and `pr-manager.ts` must invoke. Inlining in either handler duplicates the decision matrix. A dedicated module also makes the SC-002 unit test target a single import surface (7-case decision matrix vs. two handler-integration tests).

### Rationale for `findPRForBranchAnyState` as a new method (not a parameter)

Per Q2 clarification: `findPRForBranch`'s existing signature is depended on by five callers that rely on the open-only default. A `state` parameter with a default preserves compatibility but adds an easily-missed foot-gun (five call sites × one silent parameter miss = five potential regressions). A dedicated helper name makes intent explicit at the call site and eliminates the risk. Same reasoning applied to `branchExists(branch, remote?)` in `gh-cli.ts:1094` (positional bool remains, but a `remote: true` argument is explicit — the guard uses this method directly, no new wrapper needed).

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo. Verified via `ls /workspaces/generacy/.specify/memory/`.

Cross-checked against project-level `CLAUDE.md` rules:

| Rule | Compliance |
|------|-----------|
| Changeset for non-test `packages/*/src/` changes | ✔ `.changeset/1051-branch-resurrection-fix.md` planned; `@generacy-ai/workflow-engine` patch + `@generacy-ai/orchestrator` patch (bug fix, no new public exports). |
| No new label vocabulary in `workflow-engine` | ✔ No new labels introduced. FR-003b reuses existing `agent:error` and `agent:in-progress`. |
| No secrets / credentials in commits | ✔ Fix is entirely in git+GitHub-API layer; no credential handling. |
| Test suite still passes (SC-006) | ✔ SC-006 explicitly targets existing `speckit-feature` and `speckit-bugfix` happy-path tests. |
| No workflow YAML changes | ✔ FR-006 explicit. |

## Non-functional budget (FR-008)

Two extra `gh` API calls per phase (one post-`switchBranch`, one pre-`commitPushAndEnsurePr`). Phase wall-clock is minutes; two `gh` calls contribute <2s. Categorically different from the per-poll-cycle GraphQL burn rejected on #1050. FR-005 dispatch gate reuses the `fetchedIssue` already loaded at `label-monitor-service.ts:326` where available — zero incremental cost on the process path; one `getIssue` call on the resume path (the current code already fetches it inside `processLabelEvent`, so this is amortized).

## Test strategy

- **SC-001 (branch not recreated on re-entry)** — integration test using a real ephemeral git repo (mktemp) that seeds a merged-and-deleted branch state, runs `switchBranch` and `updateRepo` in sequence, and asserts `git ls-remote origin <branch>` returns empty and no push occurred. Both fetch sites exercised.
- **SC-002 (push refused with FR-003a log)** — unit test on `push-guard.ts` covering the full 7-case matrix (spec §Success Criteria). Log shape asserted via mock logger with exact `event`/`reason`/`prNumber`/`branch`/`owner`/`repo`/`issueNumber` field check. `pr-feedback-handler.push-guard.test.ts` covers the handler's integration with the guard including label state per FR-003b.
- **SC-003 (cross-issue contamination)** — regression test in `packages/orchestrator/src/__tests__/repo-checkout-cross-issue.test.ts` that seeds a reused checkout with issue-B files staged, then runs the phase-commit path for issue A, asserting HEAD's file set contains only issue-A-scoped paths (path-prefix + `specs/A-*` dir check).
- **SC-004 (dispatch drop on closed issue)** — new `label-monitor-service.closed-issue.test.ts` runs `processLabelEvent` with both `type: 'process'` and `type: 'resume'` against a stubbed `getIssue` returning `state: 'closed'`; asserts (a) no `queueManager.enqueue` call, (b) exactly one `info` log with `dropped: 'issue-closed'` + `{ issueNumber, eventType, phase }`, (c) no label mutations, no PR mutations.
- **SC-005 (`--prune` at both sites)** — static assertion inside existing `repo-checkout.test.ts` runs an `execFileMock` and inspects the argv passed to `git fetch` on both `switchBranch()` and `updateRepo()` code paths, asserting both include `--prune`. Complements the integration test in SC-001.
- **SC-006 (no happy-path regression)** — existing `speckit-feature` and `speckit-bugfix` e2e tests run unchanged. Guard's `null` PR case (first-push, no PR yet) is explicitly allow — verified by SC-002 unit matrix case 6.

## Sequencing / dependency notes

- **Order-independent**: FR-001, FR-004, FR-005 have no interdependencies with each other or with FR-002/003.
- **FR-002/003 depends on `findPRForBranchAnyState`** landing in `workflow-engine` first (one PR, ideally in the same changeset). Both handlers and `push-guard.ts` import it.
- **Defense in depth ordering**: FR-005 (dispatch drop) fires before FR-002 (pre-push guard) fires before FR-001 (prune). The fixes compose: if FR-005 misses (e.g., issue closes mid-flight), FR-002 catches; if FR-002 misses (e.g., branch present + PR open racing), FR-001 makes the checkout state visible and the reset fails loudly. All four must ship together — the failure mode compose only breaks if all four contributors are eliminated.

## Suggested next step

`/speckit:tasks` to expand this plan into an ordered task list keyed to file paths in the Project Structure section.
