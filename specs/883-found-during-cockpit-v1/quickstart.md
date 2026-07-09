# Quickstart: PR-feedback loop termination (#883)

Operator-facing summary of the behavior after this change lands.

## What changed

The PR-feedback loop now **ends its own trigger** after a successful fix cycle. In one sentence: after Claude CLI writes and pushes a diff, the handler now resolves each trusted-unresolved review thread, so the monitor's next poll sees `unresolvedThreads = 0` and stops.

## What you'll see on a normal (working) cycle

Suppose PR #14 has 5 unresolved trusted review threads and the loop fires:

1. Handler runs Claude CLI (~1-4 min).
2. Handler pushes commit `86d5f20`.
3. Handler posts **one reply per thread** (never one per comment — the observed 5 → 10 → 20 amplification is gone):
   > Addressed in `86d5f20` — please review, and re-open this thread if it still falls short.
4. Handler resolves each thread via `resolveReviewThread`. Threads render as ✅ collapsed in the GitHub UI.
5. Handler removes `waiting-for:address-pr-feedback` from the issue.
6. Next monitor poll (~5 min later) sees 0 unresolved trusted threads. No re-enqueue. Loop is done.

## What you'll see on a stuck cycle

If Claude CLI runs but produces no diff, or produces a diff but no thread resolves, the loop **pauses itself** instead of churning:

1. Handler emits a `warn` log line naming the persisting trigger.
2. Handler adds `blocked:stuck-feedback-loop` to the linked issue.
3. Handler leaves `waiting-for:address-pr-feedback` in place (the pending-feedback signal is still truthful).
4. Handler does NOT post replies.
5. Monitor polls; sees `blocked:*` on the issue; skips enqueue with a structured info log. Poll cadence continues but no further work is scheduled on this PR.

## How to unpause a stuck loop

Remove the `blocked:stuck-feedback-loop` label from the linked issue (via `gh issue edit <n> --remove-label blocked:stuck-feedback-loop` or the GitHub UI). The next monitor poll enqueues a fresh cycle.

## How to re-trigger a specific thread you disagree with

Un-resolve the thread in the GitHub UI (the "Unresolve conversation" button on the collapsed thread). The next monitor poll sees `unresolvedThreads > 0` again and enqueues a new cycle. (The bot's reply on that thread names the SHA it was addressed in — helpful when comparing to a subsequent SHA.)

## How this surfaces in cockpit

- **`cockpit status <issue>`**: an issue carrying `blocked:stuck-feedback-loop` renders in the `waiting` state with `blocked:stuck-feedback-loop` as its `sourceLabel`. Not "idle", not "in-progress" — actionable.
- **`cockpit watch <epic>`**: emits a transition line when the label is added, so an operator watching the epic sees the pause immediately.

## What to check when investigating

- **PR comment count growing across polls?** Should not happen post-fix. If it does, grep handler logs for `resolveReviewThread` — either the mutation is failing (auth or upstream) or the reply loop is falling through to the old per-comment shape.
- **Loop firing but no diff, no `blocked:*` label appearing?** Look for the FR-004 warn in handler logs — the label should be added at the same site.
- **Monitor keeps enqueueing despite `blocked:*` on the issue?** Grep monitor logs for `Skipping PR-feedback enqueue while blocked:*` — should fire on every poll while the label is present.
- **Threads replied but not resolved?** Grep handler logs for `resolveReviewThread persistently failed` — the FR-010 warn will name the thread ID and remedy (one click in the UI to resolve manually).

## Contracts

- [`contracts/resolve-review-thread.md`](contracts/resolve-review-thread.md) — new `GitHubClient.resolveReviewThread` method, retry semantics.
- [`contracts/handler-fix-cycle.md`](contracts/handler-fix-cycle.md) — reply/resolve/label-clear ordering + outcome matrix.
- [`contracts/monitor-blocked-skip.md`](contracts/monitor-blocked-skip.md) — pre-enqueue `blocked:*` skip.
