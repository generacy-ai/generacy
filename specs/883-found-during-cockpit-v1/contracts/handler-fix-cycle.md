# Contract: PrFeedbackHandler fix-cycle ordering and outcome matrix

## Ordering (spec Q4-C, Q1 tail, Q4 tail)

For a single invocation of `PrFeedbackHandler.handle(item, checkoutPath)`, the post-CLI section runs in this fixed order:

1. `commitAndPushChanges(...)` returns `hasChanges: boolean`.
2. If `!success || !hasChanges` → **Disposition B (blocked)**. Skip to step 6b.
3. `shortSha = await getHeadShortSha(...)` (best-effort; falls back to `<unknown>`).
4. For each `thread` in `trustedUnresolvedThreads` (input-set closure per Q2-A):
   1. `replyResult = await tryPostReply(thread.rootCommentId, "Addressed in <sha> — please review, and re-open this thread if it still falls short.")`
   2. `resolveResult = await tryResolveReviewThread(thread.id)` — uses the built-in 3× retry
   3. Push `{ threadId, rootCommentId, replyResult, resolveResult }` onto `outcomes`
5. `resolveSuccesses = outcomes.filter(o => o.resolveResult.ok).length`
6. Branch on `resolveSuccesses`:
   - **6a — Disposition A (success):** `resolveSuccesses ≥ 1` → for each failed thread in `outcomes`, emit exactly one FR-010 warn; then `removeFeedbackLabel(...)`; then emit the success log line.
   - **6b — Disposition B (blocked):** `resolveSuccesses === 0` (including the `!success || !hasChanges` short-circuit above) → emit the FR-004 warn; `addLabels(issue, ['blocked:stuck-feedback-loop'])`; leave `waiting-for:address-pr-feedback` in place; return without a success line.

## Outcome matrix

Let `N = trustedUnresolvedThreads.length` at cycle start. `R = resolveSuccesses`.

| CLI outcome | hasChanges | N | R | Disposition | Log surface |
|---|---|---|---|---|---|
| success | true | ≥1 | =N | A | success line; no warns |
| success | true | ≥1 | 1..N-1 | A | success line; (N-R) FR-010 warns |
| success | true | ≥1 | 0 | B | FR-006 tail warn ("commit pushed but zero resolves"); blocked:* added |
| success | false | ≥1 | — | B (short-circuit) | FR-003/FR-004 warn ("no diff"); blocked:* added |
| timeout / failure | any | any | — | B (short-circuit) | FR-013 timeout warn + FR-004 warn; blocked:* added; label kept for retry |
| success | true | 0 | — | (impossible — `N = 0` short-circuits pre-CLI at line 218) | n/a |

## Reply granularity guarantee (FR-005 / SC-004)

- The reply loop iterates `trustedUnresolvedThreads`, not `unresolvedComments`.
- Each iteration posts exactly one reply, targeted at `thread.rootCommentId`.
- Fixture PR with a thread of root + 2 replies produces exactly `+1 comment` on that thread per successful cycle.

## Success-line invariant (FR-006)

The success log line at step 6a fires only when `R ≥ 1` after retries. Equivalent phrasing: the log line is a proof that the unresolved-thread count strictly decreased (input-set closure means every counted resolve success was a trusted-unresolved thread at cycle start, so success count = count of threads that transitioned).

## Label ordering (Q4 tail)

- `blocked:stuck-feedback-loop` is added **before** any `waiting-for:*` mutation on Disposition B. `waiting-for:address-pr-feedback` is **not** touched on Disposition B (it stays as the truthful "feedback pending" signal).
- `waiting-for:address-pr-feedback` is removed **after** the reply/resolve batch on Disposition A, **after** the FR-010 warns are emitted. This ensures a partial-failure warn is not silently followed by a silent label change.

## FR-010 warn shape

For every entry in `outcomes` where `resolveResult.ok === false` on Disposition A:

```
{
  level: 'warn',
  msg: 'resolveReviewThread persistently failed after retries; label will still be cleared',
  prNumber, issueNumber, owner, repo,
  threadId,           // ReviewThread.id
  rootCommentId,      // for cross-reference in logs
  error,              // upstream stderr from the final attempt
  remedy: 'Resolve the thread manually in the GitHub UI — the reply is already on the thread',
}
```

## Non-goals

- The handler does not fetch labels; it only writes them via `addLabels`. Fetching is the monitor's job.
- The handler does not re-check `isResolved` after mutation; it counts `resolveResult.ok` and refetches on the next cycle.
- The handler does not remove `blocked:*` labels. Only operators do.
