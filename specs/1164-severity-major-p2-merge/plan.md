# Implementation Plan: Merge-conflict scoped-review lifecycle fixes

**Feature**: Fix four related defects in the merge-conflict → scoped-review lifecycle
**Branch**: `1164-severity-major-p2-merge`
**Status**: Complete

## Summary

Severity major (P2). Four defects in the merge-conflict → scoped-review path
(introduced with the engine-native review/remediate epic, generacy-ai/generacy#1120;
follow-up epic #1153):

1. **Stale `reviewScope` burns the loop to the cap.** The review executor scopes
   *every* review round to `context.reviewScope`; nothing clears it after round 1.
   A scoped review → `changes-required` → remediate pushes fix commits → the
   re-entered review is still pinned to the original pre-remediation window (whose
   charter says "Ignore files and changes outside this range"), so the fix commits
   are invisible, the same findings re-report every round, and the loop burns to the
   remediation cap **with the defect actually fixed**.
2. **"Resolution diff" includes the entire upstream base delta.** `getResolutionScope`
   sets `baseSha = HEAD^1` (pre-merge branch tip) and `headSha = HEAD` (the merge
   commit) — the full parent-1 diff, which contains *all* base-branch changes merged
   in, not just the conflict resolution. After a long-lived branch catches up to
   `develop`, the "scoped" review dwarfs the PR.
3. **Trivial-diff charter rule flags valid resolutions.** The charter's "empty or
   trivial diff → blocking finding" instruction is emitted for scoped reviews too,
   so a small-but-valid resolution triggers a spurious `changes-required` loop.
4. **Flag-combo validate bypass.** With `ciMergeGateEnabled=true` and
   `reviewPhaseEnabled=false`, a post-approval conflict resolution re-arms `continue`;
   the #1133 terminal short-circuit sees pre-existing `completed:validate` +
   `completed:implementation-review` labels → `completed: true` + mark-ready
   **without `validate` ever running on the post-merge tree**. A secondary crash
   window: `applySuccessDisposition` clears ownership labels *before* the re-arm item
   is enqueued, so a crash there silently stalls the issue.

All four fixes are orchestrator-internal (`packages/orchestrator/src/worker/` plus one
dispatcher/worker-result seam). No new label vocabulary; no new persisted state. Both
epic flags remain the on/off switches; a cluster with both OFF is unaffected.

All clarifications resolved to option **A** (clear scope; conflicted-path allowlist;
label invalidation on re-arm; reorder enqueue-before-clear). All line refs at develop
`155b3464`; exact current-tree call sites resolved below.

## Technical Context

- **Language / runtime**: TypeScript (ESM), Node >= 22.
- **Package**: `@generacy-ai/orchestrator` (`packages/orchestrator`). One touched type
  (`ReviewScope`) lives in `worker/handler-outcome.ts`, internal to the package —
  no cross-package public surface change.
- **Test runner**: Vitest. Real-git integration tests use `execFileAsync` against
  temp checkouts (pattern established in existing merge-conflict / phase-loop tests).
- **Feature flags** (both must be honored, both default OFF):
  - `reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED`
  - `ciMergeGateEnabled` / `WORKER_CI_MERGE_GATE_ENABLED`
- **Key seams discovered this session** (drive the design):
  - The merge-conflict re-arm happens **synchronously within a single
    `MergeConflictHandler.handle()` invocation** — `conflictedPaths` (enumerated at
    `merge-conflict-handler.ts:275-291` via `git diff --name-only --diff-filter=U`)
    is a **live local variable** at the `pushAndSucceed`/`finishSuccess` call site
    (`:389`). **No cross-pause persistence is required for FR-003** — thread the
    local through `pushAndSucceed → finishSuccess → getResolutionScope`.
  - `getResolutionScope` (`merge-conflict-handler.ts:940-960`) computes the
    parent-1 window; extend it to attach the conflicted-path allowlist.
  - `ReviewScope` (`worker/handler-outcome.ts:35-38`) is transported to the review
    executor **only** via `rearmItem.metadata.reviewScope`
    (`claude-cli-worker.ts:425-432`) → `WorkerContext.reviewScope` → `review-executor.ts:97`.
    Extending the type propagates the allowlist automatically.
  - The dispatcher has **no** `GitHubClient` in worker mode (`labelCleanup` is
    `undefined`, `server.ts:462-470`). The re-arm `postComplete` object is passed
    **in-process** (never serialized to Redis). So FR-008's "clear agent:* after
    enqueue" is implemented with an optional `afterEnqueue?: () => Promise<void>`
    closure on the `PostCompleteAction` rearm variant, built by the worker (which
    holds `github` at `claude-cli-worker.ts:322`) and invoked by the dispatcher
    after `enqueueIfAbsent` (`worker-dispatcher.ts:474`).
  - The #1133 terminal short-circuit (`phase-loop.ts:353-374`) reads
    `completed:validate` + `completed:implementation-review` **fresh from the issue**;
    FR-007 clears both during `applySuccessDisposition` so the short-circuit no longer
    fires on a tree that changed after those labels were granted.

## Defect → fix mapping

| Defect | FR | Fix site | Change |
|--------|----|----------|--------|
| 1 | FR-001 / FR-002 | `review-executor.ts:97-172` | Read `priorRound` **before** the reviewScope branch; honor `reviewScope` only on round 1 (`!priorRound`). Round 2+ falls back to the standard #1126 `lastReviewedCommitSha`..HEAD delta, which includes the remediation commits. |
| 2 | FR-003 | `merge-conflict-handler.ts` (`:275`, `:389`, `:561`, `:631`, `:940`) + `handler-outcome.ts:35` | Thread the live `conflictedPaths` local through `pushAndSucceed`/`finishSuccess`/`getResolutionScope`; extend `ReviewScope` with `conflictedPaths?: string[]`; charter names the allowlist instead of the raw `baseSha..headSha` parent-1 diff. |
| 3 | FR-004 / FR-005 | `review-charter.ts:143-154` | Emit the "Empty or trivial diff" paragraph only when **not** verification **and** **not** `diffWindow` (i.e. whole-PR round-1 only). |
| 4 (bypass) | FR-006 / FR-007 | `merge-conflict-handler.ts:691-714` | Add `completed:validate` + `completed:implementation-review` to the `applySuccessDisposition` remove-labels batch so the #1133 short-circuit no longer fires; `validate` runs on the post-merge tree. |
| 4 (crash window) | FR-008 (P2) | `worker-result.ts:25`, `claude-cli-worker.ts:414-450`, `worker-dispatcher.ts:472-503`, `merge-conflict-handler.ts:691-714` | Move the `agent:*` clear out of `applySuccessDisposition` into an `afterEnqueue` closure run by the dispatcher **after** `enqueueIfAbsent`. Enqueue-first ⇒ a crash leaves queued work + a stale ownership label (benign, overwritten by `onResumeStart`) instead of no label + no work. |
| all | FR-009 | — | No change to the whole-PR / flag-ON review path or non-merge-conflict re-arms; every change is gated on `reviewScope` presence, a round check, or a merge-conflict-only code path. |

## Project Structure

```
packages/orchestrator/src/
  worker/
    handler-outcome.ts            # MOD: ReviewScope gains `conflictedPaths?: string[]`
    merge-conflict-handler.ts     # MOD: thread conflictedPaths; extend getResolutionScope;
                                  #      FR-007 label removes; FR-008 stop clearing agent:*
    review-executor.ts            # MOD: FR-001 — reviewScope honored round-1 only
    review-charter.ts             # MOD: FR-004 — suppress trivial-diff for windowed reviews;
                                  #      FR-003 — render conflicted-path allowlist
    worker-result.ts              # MOD: PostCompleteAction rearm gains `afterEnqueue?`
    claude-cli-worker.ts          # MOD: build afterEnqueue closure clearing agent:* labels
    __tests__/
      phase-loop.merge-conflict-scoped-review.*.test.ts   # MOD/NEW: FR-001/002 convergence
      review-charter.scoped.test.ts                        # NEW: FR-003/004 charter shape
      merge-conflict-handler.success-disposition.test.ts   # NEW: FR-007 label set
      merge-conflict-handler.rearm-crash-window.test.ts     # NEW: FR-008 ordering
  services/
    worker-dispatcher.ts          # MOD: invoke afterEnqueue after enqueueIfAbsent
    __tests__/
      worker-dispatcher.rearm-afterenqueue.test.ts          # NEW: FR-008 dispatcher order

specs/1164-severity-major-p2-merge/
  plan.md              # this file
  research.md          # decisions + alternatives
  data-model.md        # ReviewScope / PostCompleteAction / label-set changes
  quickstart.md        # how to verify each fix
  contracts/
    review-scope.md              # extended ReviewScope + allowlist semantics
    success-disposition.md       # FR-007 label set + FR-008 afterEnqueue ordering
    scoped-review-lifecycle.md   # FR-001/002 round-gating state machine

.changeset/
  1164-merge-conflict-scoped-review-lifecycle.md   # NEW: @generacy-ai/orchestrator patch
```

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo → constitution check skipped.

## Changeset

`.changeset/1164-merge-conflict-scoped-review-lifecycle.md` — `@generacy-ai/orchestrator`
**patch** (`workflow:speckit-bugfix`). All changes are internal defect fixes:
`ReviewScope` gains an optional field but is not re-exported at the package public
boundary (internal `worker/` surface); no new label vocabulary; no new public exports.
Single changeset file. Verify with `pnpm changeset status` at implement time.

## Next Step

`/speckit:tasks` to generate the task list.

---

*Generated by speckit*
