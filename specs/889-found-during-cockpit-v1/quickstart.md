# Quickstart: #889 verification

## What this fix does

Two independent defects composed a worker crash-loop when the pre-implement base-merge (#864) hit a `CLAUDE.md` conflict on a repo that predates the `waiting-for:merge-conflicts` label:

1. `waiting-for:merge-conflicts` was never added to `WORKFLOW_LABELS`, so pre-existing repos had no such label to apply.
2. When `LabelManager` exhausted its 3-attempt retry, the error unwound to `WorkerDispatcher`, which released the item — the next worker re-claimed it and hit the same failure indefinitely.

The fix ships:

- **Label** — `waiting-for:merge-conflicts` in `WORKFLOW_LABELS`.
- **Boundary net** — `LabelManager.ensureRepoLabelsExist()`, memoized per `(process, repo)`, creates any missing `WORKFLOW_LABELS` before the first `addLabels` call in the process's lifetime for that repo.
- **Terminal-failure signaling** — `WorkerResult { status: 'failed-terminal' }` from `processItem` tells the dispatcher to `complete()` (not `release()`), then best-effort apply `agent:error` + post a `#865`-style failure-alert comment naming the failing label operation.
- **Audit** — a Vitest test that scans the codebase for `phase:*` / `completed:*` / `waiting-for:*` / `failed:*` / `agent:*` string literals and asserts each is in `WORKFLOW_LABELS`.

## Manual verification (post-implementation)

### Repro the pre-fix crash-loop (baseline)

1. Check out `develop` (before this fix lands).
2. Find a repo that has none of `waiting-for:merge-conflicts` provisioned (any repo provisioned before #864 landed — `christrudelpw/sniplink` was the original).
3. Trigger a workflow that will hit a base-merge conflict — e.g., `git checkout -b conflict-fixture; echo "conflict" >> CLAUDE.md; git commit -am "conflict"; git push`, then dispatch an issue referencing that branch through the cockpit queue.
4. Observe worker logs — expect the 3× `Label operation failed` retry pattern followed by `Worker encountered an unhandled error` and `Worker failed, item released back to queue`.
5. Observe the same item cycle through the queue again — this is the crash-loop.

### Verify the fix

1. Check out `889-found-during-cockpit-v1` after implementation lands.
2. Repeat the same repro.
3. **Expected observable changes**:
   - Worker logs show `LabelManager.ensureRepoLabelsExist` completing once at first-touch (log message `"Ensuring workflow labels exist on <owner>/<repo>"` or similar).
   - `waiting-for:merge-conflicts` is created on the repo automatically before the pause.
   - `waiting-for:merge-conflicts` and `agent:paused` land on the issue — no retry-exhaustion failure.
   - Worker completes the item and moves on to the next queue item.
4. **Failure-mode verification** (simulate terminal exhaustion despite the fix, e.g., revoke the GH token mid-flight):
   - Worker logs 3× `Label operation failed`.
   - Instead of `Worker failed, item released back to queue`, logs show `Terminal label-op failure — completing item (not releasing)` (or equivalent).
   - Issue receives a `#865`-style failure-alert comment naming `label operation failed — addLabels([waiting-for:merge-conflicts, agent:paused]) at site gate-hit`.
   - Issue receives `agent:error` label (best-effort).
   - Queue does NOT re-claim the item — verified via `redis-cli` `LRANGE queue:pending 0 -1` after the poll interval.

## Automated test verification

Run these targeted tests:

```bash
# FR-002 memoized ensure-pass
pnpm --filter @generacy-ai/orchestrator test src/worker/__tests__/label-manager.ensure.test.ts

# FR-003 terminal error class at all four sites
pnpm --filter @generacy-ai/orchestrator test src/worker/__tests__/label-manager.terminal.test.ts

# FR-005 regression: pre-existing repo pauses successfully
pnpm --filter @generacy-ai/orchestrator test src/worker/__tests__/phase-loop.merge.test.ts

# FR-006 dispatcher terminal-failure path
pnpm --filter @generacy-ai/orchestrator test src/services/__tests__/worker-dispatcher.terminal.test.ts

# FR-007 hybrid audit — must fail today for waiting-for:merge-conflicts before FR-001
pnpm --filter @generacy-ai/orchestrator test src/__tests__/label-protocol-audit.test.ts

# Non-regression sweep
pnpm --filter @generacy-ai/orchestrator test
pnpm --filter @generacy-ai/workflow-engine test
```

## Success criteria (from spec)

| SC     | Verification                                                                                                         |
|--------|----------------------------------------------------------------------------------------------------------------------|
| SC-001 | Manual repro above: 0 crash-loops on the fixture scenario after fix.                                                 |
| SC-002 | `pnpm test src/__tests__/label-protocol-audit.test.ts` — green.                                                      |
| SC-003 | `pnpm test src/services/__tests__/worker-dispatcher.terminal.test.ts` — asserts `queue.complete` called, `queue.release` NOT called, worker picks up next item within one poll interval. |
| SC-004 | Adding a new `waiting-for:*` symbol requires only appending to `WORKFLOW_LABELS`. Test: append a fixture label, drive `onGateHit(<phase>, '<fixture>')` in a scratch test, verify pause succeeds without any `LabelManager` or ensure-pass code changes. |

## Troubleshooting

- **The audit test fails on a legitimate string literal** — e.g., a doc comment mentions `phase:example`. Add the offender to `AUDIT_EXCLUSIONS: Set<string>` at the top of `label-protocol-audit.test.ts` with a comment naming the file. Prefer fixing the literal (rename or move to a fixture) over growing the exclusion set.
- **`ensureRepoLabelsExist` runs more than once per repo per process** — verify the class-level `LabelManager.ensuredRepos` `Set` is populated *before* any early-return path, and that new `LabelManager` instances read the shared static field (not an instance field). The FR-002 runtime-registry probe in the audit test catches this.
- **`createLabel` fails with "label already exists"** — a race between concurrent workers on the same repo. Wrap the `createLabel` call in a try/catch that swallows `stderr.includes('already exists')`; the retry inside `retryWithBackoff` will still ensure eventual convergence.
- **`WorkerHandler` return type breaks external consumers** — search for `WorkerHandler` outside `packages/orchestrator/src/` and add a returned `{ status: 'completed' }` at every callee's happy-path exit. TypeScript enforces the migration at build time.
