# Quickstart: `waiting-for:merge-conflicts` handler + self-describing pause

Ship 1 + Ship 2 land together in a single PR from `898-found-during-cockpit-v1`. This doc is the exercised path — how an operator sees the new behavior end-to-end after merge.

## Preconditions

- Cluster is running v1.5 with `#864` deployed (pre-phase base-merge guardrail present).
- Cluster GitHub identity has `contents:write`, `pull_requests:read`, `issues:write` on the target repo.
- Redis reachable (for `enqueueIfAbsent`).

## Verifying Ship 1 (self-describing pause)

1. On an orchestrated issue, force a pre-phase base-merge conflict:
   - Create a feature branch off `origin/<base>`.
   - On the branch, modify `CLAUDE.md` (or any file) with content that will conflict with a change on `origin/<base>`.
   - On `origin/<base>`, make an overlapping change (via a separate PR merged before re-running the phase).
2. Requeue the phase (e.g., `cockpit advance` or manually apply the phase trigger).
3. The pre-phase base-merge from `#864` fires and conflicts.
4. **Verify**: the issue's stage comment now contains a `## ⚠️ Merge conflict on base-merge` section with:
   - The conflicted paths listed.
   - A 3-step numbered manual remedy.
   - A warning callout: `Advancing without resolving first will re-pause with the same conflict.`
5. **Verify** the `waiting-for:merge-conflicts` label description reads: `Base-merge conflict. See stage comment for the manual remedy.`

Assertion path (test-mode): `packages/orchestrator/src/worker/__tests__/phase-loop.merge.test.ts` covers steps 3–4 programmatically.

## Verifying Ship 2 (engine handler)

1. Same setup as above — get an issue paused at `waiting-for:merge-conflicts + agent:paused`.
2. Within ~1 poll interval, the `MergeConflictMonitorService` observes the pause and enqueues a `resolve-merge-conflicts` queue item.
   - Watch: `docker logs <orchestrator> | grep 'Merge-conflict resolution enqueued'`.
3. A worker claims the item; `MergeConflictHandler` runs:
   - `git fetch origin`.
   - `git merge origin/<base>` (conflicts as expected).
   - Enumerates open PRs targeting `<base>` and their file lists.
   - Invokes the agent CLI **exactly once** with a bounded prompt naming conflicted paths and sibling-owned tags.
4. **Happy path (tractable conflict)**:
   - Agent resolves and commits.
   - Handler verifies (`.git/MERGE_HEAD` gone, no conflict markers).
   - Handler pushes.
   - Handler applies `completed:merge-conflicts` and removes `waiting-for:merge-conflicts` + `agent:paused`.
   - Phase re-arms; next phase run finds nothing to merge and proceeds.
5. **Blocked path (irreconcilable conflict)**:
   - Agent exits without a merge commit.
   - Handler applies `blocked:stuck-merge-conflicts`.
   - Stage comment gets an evidence block naming unresolved paths.
   - `waiting-for:merge-conflicts` remains. Monitor skips re-enqueue while `blocked:*` is present.
6. **Escalation from blocked**: operator follows the Ship 1 remedy (already in the stage comment):
   - Check out branch, merge `origin/<base>`, resolve conflicts, commit, push.
   - Remove `blocked:stuck-merge-conflicts`.
   - Run `generacy cockpit advance <issue-ref> --gate merge-conflicts`.
   - Phase re-runs; pre-merge is now a no-op; phase proceeds.

Assertion paths (test-mode):
- Monitor: `packages/orchestrator/src/services/__tests__/merge-conflict-monitor-service.test.ts` covers steps 2 + blocked skip.
- Handler happy path: `packages/orchestrator/src/worker/__tests__/merge-conflict-handler.test.ts` T1.
- Handler blocked path: same file T2.
- Sibling scope guard: T3.
- Retry budgets: T4 + T5.
- Non-fast-forward push: T6.
- No-op merge: T7.
- Unlinked issue: T8.

## Available commands

No new CLI commands. Existing commands relevant to this feature:

- `generacy cockpit status <issue-ref>` — shows the paused state and current labels.
- `generacy cockpit watch <epic-ref>` — streams transitions; will see `waiting-for:merge-conflicts` → `completed:merge-conflicts` on happy path.
- `generacy cockpit advance <issue-ref> --gate merge-conflicts` — the operator's manual advance after on-branch resolution (unchanged behavior; the Ship 1 remedy text tells operators when to use it).

## Troubleshooting

**"Issue sits at `waiting-for:merge-conflicts` and nothing happens."**
- Check the monitor is running: `docker logs <orchestrator> 2>&1 | grep 'merge-conflict monitor'`.
- Check for `blocked:*` labels on the issue — the monitor skips while any `blocked:*` is present.
- Confirm the issue is assigned to the cluster's GitHub identity (`filterByAssignee` skips unassigned issues).

**"Handler ran but the phase still fails."**
- If the push landed but the phase's next run also conflicts, the base advanced again between resolution and next phase. Expected — re-runs the loop.
- If `blocked:stuck-merge-conflicts` was applied, read the evidence block on the stage comment. The unresolved paths listed there are what the agent could not merge. Manual resolution is required (see Ship 1 remedy).

**"Handler enqueues but never runs."**
- Check queue health: `redis-cli ZCARD orchestrator:queue:pending`.
- Check in-flight set: `redis-cli SMEMBERS orchestrator:queue:in-flight-items` — the issue's `itemKey` should be there if a worker claimed it.
- Worker log: `docker logs <worker>` — look for the item dispatch log line.

**"Sibling-owned constraint didn't fire on an obvious sibling case."**
- The scope guard enumerates open PRs targeting the same base branch via `gh pr list --base <base> --state open`. If the sibling PR is closed or targets a different base, it's outside the guard. This is documented behavior (spec Out of Scope).

## Rollback

Both ships are additive:

- **Ship 1**: revert the `phase-loop.ts` and `merge-conflict-remedy.ts` changes → pause comments revert to `#864`'s original shape (paths + baseRef, no remedy).
- **Ship 2**: revert the new files under `worker/` and `services/`, revert `QueueItem.command` union extension, revert `claude-cli-worker.ts` dispatch branch → engine goes back to pre-`#898` behavior; paused issues sit indefinitely (the observed bug returns). Rollback is not recommended unless the handler misbehaves in prod; the Ship 1 remedy alone is sufficient to unstick operators.

## Related issues

- `#864` — pre-phase base-merge guardrail (upstream).
- `#874 FR-006` — "state carries its own remedy" pattern (precedent for Ship 1).
- `#883` — one-attempt termination + `blocked:*` (precedent for Ship 2).
- `#862 / #879` — `enqueueIfAbsent` in-flight dedupe (sole dedupe for the monitor).
- `#892 Q4` — same-base-in-repo enumeration for sibling scope guard.
- `agency#396` — audit that reads the label-protocol doc (Q5 rationale for FR-013 P0 priority).
