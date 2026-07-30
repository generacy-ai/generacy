# Quickstart

## What this spec adds

Four independent orchestrator-worker fixes that together prevent a re-entering worker from resurrecting a merged-and-deleted branch, committing another issue's files onto it, and opening a duplicate PR.

## Files touched

**Modified (source):**

- `packages/orchestrator/src/worker/repo-checkout.ts` — add `--prune` to two `git fetch origin` sites.
- `packages/orchestrator/src/worker/pr-feedback-handler.ts` — invoke `push-guard` before push; refuse per FR-003b.
- `packages/orchestrator/src/worker/pr-manager.ts` — invoke `push-guard` before `commitAndPush`.
- `packages/orchestrator/src/worker/phase-loop.ts` — invoke `push-guard` after `switchBranch` at phase start.
- `packages/orchestrator/src/services/label-monitor-service.ts` — drop closed-issue events at dispatch.
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts` — add `findPRForBranchAnyState`.
- `packages/workflow-engine/src/actions/github/client/interface.ts` — declare new method on `GitHubClient`.

**New (source):**

- `packages/orchestrator/src/worker/push-guard.ts` — stateless PR-state + remote-branch check.

**New (tests):**

- `packages/orchestrator/src/worker/__tests__/push-guard.test.ts` — SC-002 7-case matrix + failure isolation.
- `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.push-guard.test.ts` — SC-002 handler integration.
- `packages/orchestrator/src/services/__tests__/label-monitor-service.closed-issue.test.ts` — SC-004.
- `packages/orchestrator/src/__tests__/repo-checkout-cross-issue.test.ts` — SC-003 cross-issue contamination regression.
- `packages/orchestrator/src/__tests__/repo-checkout-branch-resurrection.integration.test.ts` — SC-001 real-git integration.
- `packages/workflow-engine/src/actions/github/client/__tests__/gh-cli.find-pr-any-state.test.ts` — new method unit test.

**Modified (tests):**

- `packages/orchestrator/src/worker/__tests__/repo-checkout.test.ts` — SC-005 static `--prune` assertions.

**New (changeset):**

- `.changeset/1051-branch-resurrection-fix.md` — `@generacy-ai/workflow-engine` patch + `@generacy-ai/orchestrator` patch.

## Running the tests

```bash
# All new & modified tests for this spec:
pnpm --filter @generacy-ai/orchestrator test push-guard
pnpm --filter @generacy-ai/orchestrator test label-monitor-service.closed-issue
pnpm --filter @generacy-ai/orchestrator test repo-checkout
pnpm --filter @generacy-ai/orchestrator test repo-checkout-cross-issue
pnpm --filter @generacy-ai/orchestrator test repo-checkout-branch-resurrection
pnpm --filter @generacy-ai/workflow-engine test find-pr-any-state

# Regression: full worker + service test suite still green
pnpm --filter @generacy-ai/orchestrator test
pnpm --filter @generacy-ai/workflow-engine test
```

## Verifying the fix locally

The observed field failure was `generacy-ai/generacy-cloud#883` — a duplicate PR opened on a resurrected branch. To reproduce and confirm the fix:

1. Check out this branch: `git checkout 1051-problem-after-speckit-pr`.
2. Ensure orchestrator is stopped: `generacy stop`.
3. In one terminal, start the orchestrator with debug logs: `pnpm --filter @generacy-ai/orchestrator dev`.
4. In another terminal, apply the following to a scratch test repo you control:
   - Create issue #A and label `process:specify` — worker runs, opens PR.
   - Squash-merge the PR with **branch deletion** (`gh pr merge --squash --delete-branch <N>`).
   - Add a completed-gate label (e.g., `completed:spec-review` + `waiting-for:spec-review`) — this triggers a resume event.
5. **Pre-fix behavior**: orchestrator picks up the resume, resurrects the deleted branch, opens a duplicate PR.
6. **Post-fix behavior**: orchestrator logs `dropped: 'issue-closed'` at `info` level (FR-005) — no git operations, no PR mutation. If the issue is still open (hand-reopen for the second test), the push-guard fires with `event: 'push-refused', reason: 'pr-merged'` (FR-003a) and refuses the push; `agent:in-progress` is cleared and `agent:error` is added.

## Grep sanity checks

Post-fix, these greps MUST match:

```bash
# FR-001: both fetch sites use --prune (SC-005)
grep -n "fetch.*origin.*--prune\|fetch.*--prune.*origin" packages/orchestrator/src/worker/repo-checkout.ts
# expect exactly 2 matches: one in switchBranch, one in updateRepo

# FR-003a: refusal log event exists exactly at push sites
grep -rn "event: 'push-refused'" packages/orchestrator/src/worker
# expect matches only in push-guard callers (pr-feedback-handler, pr-manager, phase-loop)

# FR-005: dispatch gate exists in label-monitor-service
grep -n "dropped: 'issue-closed'" packages/orchestrator/src/services/label-monitor-service.ts
# expect exactly 1 match
```

And these greps MUST NOT match:

```bash
# Verify findPRForBranch's signature was NOT modified
grep -n "async findPRForBranch(.*state" packages/workflow-engine/src/actions/github/client/gh-cli.ts
# expect no match — findPRForBranch signature unchanged

# Verify --prune was NOT accidentally added to fetchBase
grep -n "fetch.*origin.*<baseBranch>.*--prune\|fetch.*--prune.*<baseBranch>" packages/orchestrator/src/worker/repo-checkout.ts
# expect no match
```

## Troubleshooting

- **"gh pr list returns empty for a branch that has a merged PR"** → confirm you're calling `findPRForBranchAnyState`, not `findPRForBranch`. `gh pr list` defaults to `--state open`.
- **"push-guard allowed a push against a merged branch"** → check the failure-isolation clause in `contracts/push-guard.md` — if either lookup throws, the guard returns `allow`. Verify with a `gh` availability check in your test env.
- **"label-monitor drop doesn't fire on my closed test issue"** → the gate only fires if `fetchedIssue` is populated. Check the `try/catch` at `label-monitor-service.ts:324-333` — a swallowed fetch error leaves `fetchedIssue = null` and the gate is skipped by design (fallback proceeds to enqueue).
- **"my SC-003 regression test passes even without FR-004 changes"** → the test seeds working-tree state before running the phase-commit path. If your seed doesn't survive the `git reset --hard HEAD` + `git clean -fd` inside `switchBranch`, your test isn't exercising the contamination mechanism. Stage the files but don't commit — `git reset --hard HEAD` will drop them, verifying the invariant.

## Suggested next step

Run `/speckit:tasks` to expand this plan into an ordered task list keyed to the files above.
