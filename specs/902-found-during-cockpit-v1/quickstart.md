# Quickstart: `#902` MergeConflictHandler success-path re-arm

Companion to `plan.md`. How to exercise the fix locally, what commands run, and how to diagnose the sniplink#6/#7/#8 dead-park pattern in a live cluster.

## Prerequisites

- Node.js `>= 22`.
- `pnpm install` completed at repo root.
- `git`, `gh` on PATH.
- Firebase emulators running (per `/workspaces/tetrad-development/docs/DEVELOPMENT_STACK.md`) if exercising the full worker/dispatcher path.

## Running the fix locally

```bash
# From repo root
pnpm --filter @generacy-ai/orchestrator build
pnpm --filter @generacy-ai/orchestrator test
```

The new/modified files under `packages/orchestrator/src/worker/` are:

| File | Nature | Purpose |
|---|---|---|
| `handler-outcome.ts` | NEW | `HandlerOutcome` discriminated union (FR-005) |
| `handler-outcome-assertion.ts` | NEW | Runtime post-exit assertion (FR-006) |
| `pause-context.ts` | NEW | Pause-context sidecar API (FR-003 mechanism) |
| `merge-conflict-handler.ts` | MODIFIED | Returns `HandlerOutcome`; combined `gh issue edit` on success (FR-001, FR-002, FR-007) |
| `phase-loop.ts` | MODIFIED | Writes pause-context before `onGateHit` (FR-003) |
| `claude-cli-worker.ts` | MODIFIED | Reads pause-context, threads outcome to `WorkerResult.postComplete` (FR-002, FR-004, FR-008) |
| `worker-result.ts` | MODIFIED | Adds `PostCompleteAction` (Decision 7) |

## Test suites

Run the new/modified handler tests:

```bash
pnpm --filter @generacy-ai/orchestrator test -- \
  src/worker/__tests__/merge-conflict-handler.test.ts \
  src/worker/__tests__/merge-conflict-handler.rearm.test.ts \
  src/worker/__tests__/merge-conflict-handler.noop.test.ts \
  src/worker/__tests__/merge-conflict-handler.second-cycle.test.ts \
  src/worker/__tests__/merge-conflict-handler.fail-loud.test.ts \
  src/worker/__tests__/pr-feedback-handler.assertion.test.ts
```

Expected: all green. FR-006's `assertHandlerOutcomeMatchesWorld` fires on every terminal state.

## Reproducing the sniplink#6/#7/#8 dead-park (regression check)

To confirm the *pre-fix* bug on a test cluster:

1. Create a feature-workflow issue.
2. Get it to `implement` phase.
3. Trigger a pre-implement base-merge conflict (push a conflicting change to base).
4. Confirm `waiting-for:merge-conflicts` + `agent:paused` label state.
5. Resolve the conflict on the branch manually (leaving the pause labels).
6. Observe the handler run its no-op success path.

**Pre-fix**: issue lands at `completed:merge-conflicts` + `agent:in-progress` + no `waiting-for:*` — dead-park.

**Post-fix**: issue lands with all four labels removed (`completed:merge-conflicts`, `waiting-for:merge-conflicts`, `agent:paused`, `agent:in-progress`), and a `continue` item enters the queue with `startPhase = validate` (or whatever phase was interrupted). Next poll picks it up, phase loop re-enters.

## Diagnosing a live dead-park (pre-fix)

If you see a workflow paused on `completed:merge-conflicts` + `agent:in-progress` with no `waiting-for:*` and no `blocked:*`:

1. **Confirm the dead-park class**: `gh issue view <issue> --json labels --jq '.labels[].name'` should show `completed:merge-conflicts`, `agent:in-progress`, and any `completed:<phase>` chain, but no `waiting-for:*`, no `blocked:*`, no `failed:*`.
2. **Manual repair** (matches the sniplink fix):

   ```bash
   OWNER=christrudelpw
   REPO=sniplink
   ISSUE=6
   PHASE=implementation-review   # gate name whose pair triggers a resume

   gh issue edit $ISSUE --repo $OWNER/$REPO \
     --remove-label agent:in-progress \
     --remove-label completed:merge-conflicts \
     --add-label waiting-for:$PHASE \
     --add-label completed:$PHASE \
     --add-label agent:paused
   ```

   The next label-monitor poll observes the pair and enqueues a `continue` item.

3. **Post-fix diagnostic**: this shouldn't happen anymore. If it does, check the pause-context sidecar at `<checkoutPath>/.generacy/pause-context-<workflowId>.json` — its absence or corruption sends the handler to the fail-loud path, which lands at `blocked:stuck-merge-conflicts` (a detectable state), not the dead-park class.

## Reading pause-context off a checkout

For debugging in a running cluster:

```bash
CHECKOUT=/workspaces/<project>
WORKFLOW_ID=owner_repo_N
cat $CHECKOUT/.generacy/pause-context-$WORKFLOW_ID.json
```

Expected shape:

```json
{
  "phase": "validate",
  "writtenAt": "2026-07-10T14:23:45.000Z",
  "issueRef": "owner/repo#N"
}
```

If missing after a merge-conflict pause has fired, the phase-loop pause-site write failed — check worker logs for `writePauseContext` errors. This is a real bug (not a dead-park class, but a data-loss class) and should be filed.

## Handler outcome invariant — dev-mode enforcement (future)

The `assertHandlerOutcomeMatchesWorld` helper is pure — you can wire it into prod code as a dev-mode assertion if operators want a runtime-enforced invariant. Sketch:

```typescript
// In ClaudeCliWorker.handle after handler.handle returns:
if (process.env.ORCH_DEV_ASSERT_HANDLER_OUTCOME === '1') {
  const labels = (await github.getIssue(...)).labels.map(l => typeof l === 'string' ? l : l.name);
  const pending = await queueManager.getQueueItems(0, 100);
  const snapshot: QueueSnapshot = {
    inFlight: await queueManager.hasInFlight(`${item.owner}/${item.repo}#${item.issueNumber}`),
    pendingItems: pending.map(p => p.item),
  };
  const check = assertHandlerOutcomeMatchesWorld(outcome, labels, snapshot);
  if (!check.ok) {
    workerLogger.error({ mismatch: check.mismatch, outcome }, 'HandlerOutcome does not match world');
  }
}
```

Off by default. FR-006 is satisfied by the test-fixture wiring today.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Handler success path fires but no `continue` item in queue | `WorkerDispatcher.runWorker` postComplete branch not wired | Confirm the `runWorker` change from `contracts/rearm-flow.md` is applied. |
| `HandlerOutcome` compile error at handler exit | Handler branch returned before setting an outcome | Every terminal branch must return a `HandlerOutcome`. Type checker will flag missing branches. |
| Pause-context sidecar exists but handler enters fail-loud path | `readPauseContext` returned null due to schema mismatch | Check the JSON schema in `pause-context.ts` matches the writer's payload. |
| Rearm enqueue always drops with "already in-flight" | `queue.complete` didn't fire before `enqueueIfAbsent` | Confirm the ordering in `runWorker` — `queue.complete` MUST precede the `postComplete` action. |
| `PrFeedbackHandler` fixture fails assertion after wrap | Latent `#902`-class bug in `PrFeedbackHandler` | This is exactly what FR-009 is designed to surface. File as a follow-up. |

## Available commands (relevant slash commands + CLI verbs)

- `/plan` — regenerates this planning stack from `spec.md`.
- `/tasks` — generates the task list from `plan.md`, `research.md`, `data-model.md`.
- `/implement` — walks the task list; each task is a small edit + test.
- `generacy cockpit resume <issue-ref>` — CLI verb to unstick a dead-parked issue. Applies the manual repair described above (currently in-flight per `#891` per `CLAUDE.md`).

## Next step

Run `/tasks` to generate the ordered task list from this planning stack.
