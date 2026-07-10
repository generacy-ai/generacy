# Contract: `MergeConflictHandler`

**File**: `packages/orchestrator/src/worker/merge-conflict-handler.ts` (new)
**Shape template**: `packages/orchestrator/src/worker/pr-feedback-handler.ts:55` (`PrFeedbackHandler`)

## Public surface

```ts
export class MergeConflictHandler {
  constructor(
    config: WorkerConfig,
    logger: Logger,
    agentLauncher: AgentLauncher,
    sseEmitter?: SSEEventEmitter,
  );

  /**
   * Process a merge-conflict resolution task.
   *
   * @param item        - Queue item with command: 'resolve-merge-conflicts'
   * @param checkoutPath - Path to the already-checked-out repository
   * @throws            - Only on non-recoverable environment errors (bad
   *                      checkoutPath, unauthenticated gh, etc.). Handler
   *                      failures that produce a valid blocked disposition
   *                      do NOT throw — they return normally after label
   *                      mutation + evidence emission.
   */
  async handle(item: QueueItem, checkoutPath: string): Promise<void>;
}
```

## Flow

```
1. Parse item → { owner, repo, issueNumber, metadata }
2. Create GitHubClient scoped to checkoutPath
3. Resolve PR + branch via existing PrLinker (mirror pr-feedback-handler.ts:94-106)
   - If no PR found: apply blocked:stuck-merge-conflicts + evidence
     (unresolvedPaths=[], message="no linked PR"), return.
4. switchBranch(checkoutPath, branchName) — with 3× retry on transient errors
5. resolveBaseBranch(github, prManager, checkoutPath, owner, repo, logger)
   from base-merge.ts:67 → baseRef (e.g., "origin/develop")
6. git fetch origin — 3× retry
7. git merge origin/<base> — no --no-commit; want a committable state
   - Retry 3× on ECONNRESET / ETIMEDOUT / index.lock
   - Exit code 0 (clean merge, no conflicts) → JUMP to step 15 (no-op success)
   - Non-zero + conflicts reported → CONTINUE
   - Non-zero + no conflicts (unexpected git failure) → apply blocked:*, return
8. Enumerate conflicted paths: git diff --name-only --diff-filter=U → paths[]
9. Enumerate open PRs targeting baseRef.replace('origin/', '') via
   github.listOpenPullRequests(owner, repo) — filter pr.base.ref === base
10. For each sibling PR: gh pr view <number> --json files → cache paths
11. Build MergeConflictIntent.prompt via buildMergeConflictPrompt({
      conflictedPaths: paths,
      siblingOwnedPaths: paths.filter(p => any sibling has p),
      baseRef,
      branch,
    })
12. Invoke agentLauncher.launch({ intent }) — EXACTLY ONCE (Q4→D, FR-004)
13. Post-agent verification (research.md §6):
    a. Fail if fs.existsSync(join(checkoutPath, '.git/MERGE_HEAD'))
       → agent did not complete the merge
    b. Fail if git diff --name-only --diff-filter=U returns any path
       → conflict markers remain
    c. Fail if HEAD commit has no parents other than pre-merge HEAD
       + baseRef merge-base (belt & suspenders — merge commit shape check)
    Any fail → JUMP to step 17 (blocked disposition)
14. git push origin <branch> — 3× retry on network errors (FR-006 / Q4→D)
15. On success:
    a. github.addLabels(owner, repo, issueNumber, ['completed:merge-conflicts'])
    b. github.removeLabels(owner, repo, issueNumber, [
         'waiting-for:merge-conflicts', 'agent:paused',
       ])
    c. logger.info — one summary line
    d. return
16. [No step 16 — success and failure paths differ]
17. On failure (Disposition B, FR-008/FR-009):
    a. Compute unresolvedPaths + partiallyResolvedPaths from git state
    b. Emit BlockedStuckMergeConflictsEvidence into stage comment
       (via a StageCommentManager call or a Fastify-style helper —
       shape TBD in tasks phase, but data-model.md fixes the payload)
    c. github.addLabels(owner, repo, issueNumber, ['blocked:stuck-merge-conflicts'])
    d. Leave waiting-for:merge-conflicts + agent:paused in place (FR-008)
    e. logger.warn — one summary line naming the unresolvedPaths
    f. return
```

## Success predicate

The handler considers the agent's attempt successful iff all three hold:

- `.git/MERGE_HEAD` does **not** exist in the checkout path (git considers the merge complete).
- `git diff --name-only --diff-filter=U` returns **empty** (no unresolved paths per git's own accounting).
- No file in the tree contains the conflict-marker sentinel `<<<<<<< ` at line-start (belt-and-suspenders against agent staging a file with markers still inside).

Fail any → Disposition B.

## Sibling-owned path constraint

For any path tagged `sibling-owned: true`:

- The agent prompt (built in `merge-conflict-prompt.ts`) MUST include an explicit paragraph naming the sibling PR(s) and instructing the agent that `git checkout --theirs <path>` and `git checkout --ours <path>` are forbidden — a **merged** resolution is required.
- The success predicate is the same; the prompt is the enforcement mechanism (the git state itself cannot distinguish "merged" from "took theirs", but the agent's task instruction bounds behavior).
- If the agent does use `--theirs` / `--ours` on a sibling-owned path despite the instruction, the merge is still verified as conflict-free and pushes. The scope guard is best-effort at the prompt level per Q3 (which chose option A with the corrected enumeration). Programmatic enforcement of "the resolution merges both sides" is not tractable without semantic understanding of the file content.

## Idempotency

- **On the queue item**: the handler runs to completion for each dequeue. The item completes normally (queue.complete()) in both success and blocked paths. No re-enqueue is triggered from within the handler.
- **Label mutations**: `addLabels` and `removeLabels` are idempotent on the GitHub API (adding an existing label is a no-op; removing an absent label 404s and is caught).
- **Push**: the `git push` on step 14 does NOT use `--force`. A rejected push (non-fast-forward) triggers Disposition B, not retry.

## Retry budgets (Q4 → D)

| Operation | Budget | Backoff | Notes |
|-----------|--------|---------|-------|
| Branch checkout / switch | 3× | 250ms, 500ms, 1000ms | Retriable classes: index.lock, transient FS errors. |
| `git fetch origin` | 3× | 250ms, 500ms, 1000ms | Retriable classes: ECONNRESET, ETIMEDOUT, RPC failed. |
| `git merge origin/<base>` | 3× | 250ms, 500ms, 1000ms | Retriable ONLY if git exited with an env error (index.lock, RPC). Clean conflict output does NOT retry — that's the expected path forward. |
| Agent-CLI invocation | 1× | — | The one autonomous attempt. Any exit is decisive. |
| `git push origin <branch>` | 3× | 250ms, 500ms, 1000ms | Retriable ONLY on network errors. Non-fast-forward rejection does NOT retry. |
| GitHub API label ops (add/remove) | Uses `retryWithBackoff` from label-manager.ts (existing) | — | Same policy as other label callers. |

## Observability

- Every branch emits exactly one structured log line naming `owner`, `repo`, `issueNumber`, `phase='merge-conflict-resolution'`, and the disposition (`success`, `blocked`, `no-op`).
- The agent-CLI invocation is traceable via existing `AgentLauncher.launch` telemetry — no new hook here.
- Sibling-owned path enumeration emits one debug line naming the total sibling PR count and the conflicted-path partition (sibling-owned vs. not).

## Failure escalation

The Disposition B `blocked:stuck-merge-conflicts` label is the sole escalation surface. Operator action is described in the Ship 1 pause comment remedy (see `pause-comment-schema.md`). No retry, no automatic re-queue.

## Test coverage (must-have)

- **T1**: happy path — synthetic single-file `CLAUDE.md` conflict → mock `AgentLauncher.launch` writes a resolved file + commits → assert push called, `completed:merge-conflicts` added, `waiting-for:merge-conflicts` removed.
- **T2**: agent produces no resolution — mock `AgentLauncher.launch` returns without touching files → assert `.git/MERGE_HEAD` still present → `blocked:stuck-merge-conflicts` added + evidence emitted, `waiting-for` preserved.
- **T3**: sibling-owned path enumeration — mock `listOpenPullRequests` returns 2 open sibling PRs, one of which touches the conflicted path → assert prompt string contains "sibling-owned" and "must NOT use `--theirs`/`--ours`" against that path.
- **T4**: pre-agent fetch retry — mock git-fetch to fail 2× with `ECONNRESET`, then succeed → assert 3 fetch calls, agent invoked once (attempt not spent).
- **T5**: post-agent push retry — mock git-push to fail 2× with `ECONNRESET`, then succeed → assert 3 push calls, success labels applied.
- **T6**: non-fast-forward push rejection — mock git-push to fail with "! [rejected] non-fast-forward" → assert NO retry, blocked disposition applied.
- **T7**: no-op merge (branch already up to date with base) — assert immediate success without agent-CLI invocation, labels cleared.
- **T8**: unlinked issue — no PR found for the issue → assert `blocked:stuck-merge-conflicts` + evidence with "no linked PR" message.
