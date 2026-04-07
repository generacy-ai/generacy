# Clarifications: Resume-After-Failure Retry Logic for Implement Phase

## Batch 1 — 2026-03-10

### Q1: Commit Message for Partial-Progress Commits
**Context**: `commitPushAndEnsurePr` uses the message `"chore(speckit): complete ${phase} phase for #${issueNumber}"`. When called in the failure/retry detection path (before the retry), this creates a commit saying "complete implement phase" even though the phase failed. Separately, the `hasPriorImplementation` check (phase-loop.ts lines 228-242) searches for `"complete ${phase} phase"` to detect prior work — if partial retry commits use the same message, the final retry's no-changes detection would soft-pass via `hasPriorImplementation`. If a different message is used, the no-changes check might produce a false error on the final retry.
**Question**: Should `commitPushAndEnsurePr` use the same commit message when called in the failure/retry path, or a distinct message like `"wip: partial implement progress — retry N"`? And if a distinct message, should `hasPriorImplementation` be updated to also match it?

**Answer**: Use a distinct message like `wip(speckit): partial implement progress for #${issueNumber} (retry ${retryCount})`, and update `hasPriorImplementation` to also match `partial implement progress`. The current message `complete ${phase} phase` is semantically wrong for a failed/partial run. A distinct message is more accurate for debugging and git history. The `hasPriorImplementation` check just needs one extra `.includes()` — `c.message.includes('partial implement progress')` — so the final retry's no-changes path still soft-passes correctly.

---

### Q2: Stage Comment Update for Retry Status (US3 vs FR-006)
**Context**: US3 acceptance criterion states "Stage comment is updated to reflect retry attempt and count." FR-006 says "Log warn message at minimum." The spec's pseudocode only includes a `this.logger.warn(...)` call in the retry path — no `stageCommentManager.updateStageComment(...)` call. A log line is internal-only and not visible in the GitHub issue comment.
**Question**: Does satisfying US3 require calling `stageCommentManager.updateStageComment` in the retry path (e.g., with `status: 'in_progress'` and a retry message), or is `this.logger.warn` alone sufficient?

**Answer**: Yes, call `stageCommentManager.updateStageComment` in the retry path. `logger.warn` alone does not satisfy US3. The stage comment is the only artifact visible on the GitHub issue. The update should show `status: 'in_progress'` with a message like "Retrying implement phase (attempt 2/3) — partial progress committed".

---

### Q3: Multiple Implement Results in `PhaseLoopResult`
**Context**: In `phase-loop.ts`, the failed `PhaseResult` is pushed to the `results` array at line 187 (`results.push(result)`) before the failure check. On retry, another `PhaseResult` for `implement` will be added. The `PhaseLoopResult` type returns all `results`. Callers may not expect multiple entries for the same phase.
**Question**: Is it intentional that the `results` array may contain multiple `PhaseResult` entries for the `implement` phase (one per attempt)? Do callers of `executeLoop` need updating to handle this, or should the failed attempt's result be excluded/replaced?

**Answer**: Keep all results — multiple entries for implement is fine and intentional. `PhaseLoopResult.results` is typed as `PhaseResult[]` with no uniqueness constraint. Having one entry per attempt provides a complete execution history. Callers only check `completed` and `gateHit` on the top-level result, not individual phase entries. No caller updates needed.

---

### Q4: Phase Timestamp Overwrite on Retry
**Context**: `phaseTimestamps.set(phase, { startedAt: new Date().toISOString() })` is called at the top of each loop iteration (phase-loop.ts line 108). When `i--; continue;` re-runs implement, this overwrites the failed attempt's `startedAt` timestamp. The stage comment shows per-phase timing based on these timestamps.
**Question**: Should the stage comment timestamp reflect only the latest retry attempt's start time (i.e., overwrite is fine), or should it span from the first attempt to completion (i.e., preserve the original `startedAt` on retry)?
**Options**:
- A: Overwrite — show timing of the latest attempt only
- B: Preserve — only set `startedAt` if not already set, so it spans the entire implement phase including all retries

**Answer**: Option B — preserve the original `startedAt`. Only set it if not already set. The stage comment should reflect total wall-clock time for the implement phase across all retries. A one-line guard (`if (!phaseTimestamps.has(phase))`) before the `.set()` call is all that's needed.

---

### Q5: `labelManager.onPhaseStart` on Re-entry After Retry
**Context**: When `i--; continue;` re-runs the implement phase, `labelManager.onPhaseStart(phase)` is called again at line 111. `labelManager.onError` is NOT called before the retry (the code continues before reaching it). `onPhaseStart` presumably re-adds the `phase:implement` label or sets the in-progress state.
**Question**: Is it safe/correct to call `labelManager.onPhaseStart('implement')` multiple times (once per attempt) without an intervening `onError` or `onPhaseComplete`? Or should `onError` be called before the retry to cleanly transition label state before re-entering the phase?

**Answer**: It's safe to call `onPhaseStart('implement')` again without an intervening `onError`. Do **not** call `onError` before retry. `onPhaseStart` is idempotent — it removes other phase labels and adds/re-adds the current one. Calling `onError` before retry would add the `agent:error` label and remove `agent:in-progress`, which is wrong since we're actively retrying. The correct label state during retry is `phase:implement` + `agent:in-progress`, which is exactly what repeated `onPhaseStart` calls maintain.
