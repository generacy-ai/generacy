# Research: Resume-After-Failure Retry Logic for Implement Phase

## Technology Decisions

### 1. Retry Signal: `hasChanges` from `commitPushAndEnsurePr`

**Decision**: Use the boolean `hasChanges` returned by `prManager.commitPushAndEnsurePr()` as the sole signal for whether a retry should be attempted.

**Rationale**:
- `commitPushAndEnsurePr` already checks both uncommitted working-tree changes and unpushed commits
- Returns `true` if the phase did any work, `false` if it was a clean failure
- Reusing this existing call avoids a separate git status check and keeps logic in one place
- The commit itself preserves the partial progress before the fresh session starts

**Alternative considered**: Checking git working tree status directly (`getStatus()`) before calling commit. Rejected because `commitPushAndEnsurePr` already wraps this logic and also handles the push.

### 2. Custom Commit Message via Optional Parameter

**Decision**: Add `options?: { message?: string }` to `commitPushAndEnsurePr` and pass through to `commitAndPush`.

**Rationale**:
- Minimal change to existing interface (backward compatible — optional parameter)
- The default message `chore(speckit): complete ${phase} phase` is semantically wrong for a failed/partial run
- Distinct WIP message `wip(speckit): partial implement progress for #N (retry R)` improves git history readability and accurate debugging
- Required for `hasPriorImplementation` disambiguation: the check needs to distinguish between a successful completion commit and a WIP retry commit

**Alternative considered**: Using a separate `commitPartialProgress(issueNumber, retryCount)` method. Rejected as over-engineering — the only difference is the commit message.

### 3. Session Reset on Retry

**Decision**: Set `currentSessionId = undefined` when retrying.

**Rationale**:
- The failed session's context is either exhausted or corrupted (timeout, crash, OOM)
- Resuming a crashed session would immediately hit the same failure
- Starting fresh guarantees the new session gets a full context window
- Task idempotency (`[X]` markers in tasks.md) handles skipping already-completed work

### 4. `StageCommentData.message` — Not Added

**Decision**: Do NOT add a `message` field to `StageCommentData` for this feature.

**Rationale**:
- US3 requires retry status to be "visible in the GitHub issue comment" — showing the implement phase as `in_progress` satisfies this
- Adding a new field to `StageCommentData` would require changes to `stage-comment-manager.ts` (rendering) and test updates, outside the minimal scope
- If richer retry messaging is needed, it can be added in a follow-up targeting the stage comment rendering layer

### 5. Retry Counter Placement

**Decision**: Declare `implementRetryCount` as a `let` variable before the phase loop, not inside it.

**Rationale**:
- The loop re-enters the implement phase via `i--; continue;` — a variable declared inside the loop body would reset on each iteration
- Placing it outside the loop ensures the counter persists across retry attempts
- Simple and explicit; no new data structure needed

## Implementation Patterns

### Existing Idempotency (No Changes Required)

The existing `hasPriorImplementation` check (phase-loop.ts:229-233) already handles the case where a fresh session produces no changes because all work was done in a prior run. The only change needed is adding `.includes('partial implement progress')` to match WIP retry commits — without this, the final retry attempt (where tasks.md is fully `[X]`) would not find prior work and would error instead of soft-passing.

### Label State During Retry

`labelManager.onPhaseStart('implement')` is called again when `i--; continue;` re-enters the loop. This is safe because `onPhaseStart` is idempotent — it removes other phase labels and ensures `phase:implement` + `agent:in-progress` are present. Calling `onError` before retry would incorrectly transition to `agent:error`, which is wrong while actively retrying.

### Multiple PhaseResult Entries

The `results` array will contain one `PhaseResult` per implement attempt (e.g., two entries if one retry occurs). This is intentional — `PhaseLoopResult.results` has no uniqueness constraint, and a complete execution history is more useful than a single entry. No callers need updating since they only access `completed` and `gateHit` on the top-level `PhaseLoopResult`.

## Key References

- Root cause: generacy-ai/generacy-cloud#133 — all 7 tasks completed, context exhausted on test update, all work lost
- `packages/orchestrator/src/worker/phase-loop.ts` — core loop, lines 96-368
- `packages/orchestrator/src/worker/config.ts` — Zod schema for `WorkerConfig`
- `packages/orchestrator/src/worker/pr-manager.ts` — `commitPushAndEnsurePr` (line 42)
- `packages/orchestrator/src/worker/types.ts` — `StageCommentData` (line 148)
