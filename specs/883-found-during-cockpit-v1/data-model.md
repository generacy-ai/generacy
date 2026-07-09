# Data Model: PR-feedback loop termination (#883)

Only the shapes that change (or are added) are documented here. Everything else in the handler / monitor / cockpit surface is unchanged from prior work.

## 1. `ReviewThread` (extended)

**Location:** `packages/workflow-engine/src/types/github.ts` (~line 112)

The GraphQL node `id` becomes required so the handler can call `resolveReviewThread`. Spec §Assumptions calls out this extension explicitly.

```ts
export interface ReviewThread {
  /**
   * GitHub GraphQL node ID for the thread. Consumed by
   * `resolveReviewThread(input: { threadId })`. See #883.
   */
  id: string;

  /** databaseId of the first (root) comment in the thread. Stable identifier. */
  rootCommentId: number;

  /** True when the thread has been marked resolved in the GitHub UI. */
  isResolved: boolean;

  /** All comments in the thread, in chronological order. */
  comments: Comment[];
}
```

**Populated at:** `GhCliGitHubClient.getPRReviewThreads` (`gh-cli.ts:479`). The GraphQL query is extended to select `id` on each `reviewThreads.nodes` element; the mapping at `gh-cli.ts:550-579` copies `node.id` onto the returned `ReviewThread`.

**Consumers:** `PrFeedbackHandler` (calls `github.resolveReviewThread(thread.id)`); `PrFeedbackMonitorService` (does NOT consume the new field — the monitor's trust-filter branch still works off `rootCommentId` for the untrusted-notice logic).

## 2. `GitHubClient.resolveReviewThread` (new method)

**Location:** `packages/workflow-engine/src/actions/github/client/interface.ts`

```ts
/**
 * Resolve a PR review thread via GraphQL `resolveReviewThread` mutation.
 *
 * Retries transient failures 3× with 1s/2s/4s backoff (spec Q1-C). Throws
 * `GhAuthError` on 401 (existing convention, #762). Throws `Error` with the
 * upstream stderr on any other post-retry failure.
 *
 * @param threadId - The GraphQL node ID of the thread (see ReviewThread.id).
 */
resolveReviewThread(threadId: string): Promise<void>;
```

**Implementation:** `GhCliGitHubClient.resolveReviewThread` in `gh-cli.ts`. Invocation shape:

```
gh api graphql \
  -f query='mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }' \
  -F id=<threadId>
```

Retry loop (internal to the method):
- Attempt 1 → wait 1000ms → Attempt 2 → wait 2000ms → Attempt 3 → wait 4000ms → give up
- Transient = non-401 non-auth `executeGh` failure. Auth failure (`GhAuthError`) is NOT retried; it is thrown immediately (aligns with #762 convention).
- Total budget: ~7s per persistently-failing thread.

## 3. `PerThreadOutcome` (handler-internal)

Not exported; used only inside `PrFeedbackHandler.handle` for aggregating strict-decrease and per-thread warns.

```ts
type OutcomeResult = { ok: true } | { ok: false; error: string };

interface PerThreadOutcome {
  threadId: string;          // ReviewThread.id
  rootCommentId: number;     // for logs + FR-005 grep test
  replyResult: OutcomeResult;
  resolveResult: OutcomeResult;
}
```

**Consumed by:** FR-006 strict-decrease check (`outcomes.filter(o => o.resolveResult.ok).length`) and FR-010 per-thread warn loop (`outcomes.filter(o => !o.resolveResult.ok)`).

## 4. `blocked:stuck-feedback-loop` label (new)

**Location:** `packages/workflow-engine/src/actions/github/label-definitions.ts` (added to `WORKFLOW_LABELS`).

```ts
{
  name: 'blocked:stuck-feedback-loop',
  color: 'D73A4A',    // red — matches other blocked-severity labels
  description: 'PR-feedback loop paused itself: last cycle could not advance the trigger. Remove this label to permit another attempt.',
},
```

**Lifecycle:**
- Added by `PrFeedbackHandler` on: (a) `!success` cycle (CLI did not complete cleanly), (b) `success && !hasChanges` cycle (no diff), (c) `success && hasChanges && resolveSuccesses === 0` cycle (commit landed but nothing transitioned).
- Removed by: the operator, via the GitHub UI or CLI. There is no agent-side removal path — its removal is the explicit human "try again" signal.
- Persists across polls: as long as the label is present, `PrFeedbackMonitorService` skips enqueue with a structured info log.

**Not tied to** `waiting-for:address-pr-feedback`: they coexist. `waiting-for:*` is the truthful "there is pending feedback" state (Q3-B / prior #879 discipline). `blocked:stuck-feedback-loop` is "and the loop is paused." Removing either one independently is meaningful.

## 5. `blocked:*` prefix as monitor skip predicate

**Location of predicate:** inline in `PrFeedbackMonitorService.processPrReviewEvent`, after the trust-live check (~line 315), before `addLabels(waiting-for:address-pr-feedback)` (line 328).

**Semantic:** any label with the `blocked:` prefix on the linked issue skips enqueue. There is no allow-list of specific `blocked:*` values; the prefix itself is the contract. Future stuck-in-a-different-way labels can piggyback without touching monitor code.

**Skip does NOT propagate to:**
- The zero-trusted-untrusted-notice path (Case B at monitor line 280) — that path exits before reaching the `blocked:*` check and its behavior is unchanged.
- The zero-unresolved case (Case C at monitor line 254) — same as above.

## 6. Cockpit classifier: `blocked:*` → `waiting` tier

**Location:** `packages/cockpit/src/state/label-map.ts` `classifyByPattern` (line 29).

The prefix branch is extended:

```ts
if (label.startsWith('waiting-for:') || label.startsWith('needs:') || label.startsWith('blocked:')) return 'waiting';
```

**Effect on `LABEL_TO_STATE`:** the map, built at module-load by iterating `WORKFLOW_LABELS`, now includes `blocked:stuck-feedback-loop → 'waiting'`. Any other `blocked:*` added to `WORKFLOW_LABELS` in the future inherits the tier automatically.

## 7. Cockpit `WAITING_PIPELINE_ORDER` (extended)

**Location:** `packages/cockpit/src/state/precedence.ts` (line 26).

`blocked:stuck-feedback-loop` is prepended, giving it top priority within the `waiting` tier for the tie-break comparator.

```ts
export const WAITING_PIPELINE_ORDER: string[] = [
  'blocked:stuck-feedback-loop',      // NEW: highest priority
  'waiting-for:spec-review',
  'waiting-for:clarification',
  ...
];
```

**Effect on `ClassifyResult`:** when the label set contains both `waiting-for:address-pr-feedback` and `blocked:stuck-feedback-loop`, the comparator returns the latter as `sourceLabel`. `cockpit status` shows `blocked:stuck-feedback-loop` in the state column; `cockpit watch` emits a transition line the moment the label appears.

## 8. `PrFeedbackMetadata` (unchanged)

Included here for clarity — `PrFeedbackMetadata.reviewThreadIds` (root comment IDs) stays exactly as-is. Thread node IDs are consumed handler-side from the fresh GraphQL fetch, not threaded through metadata. Rationale: the handler already re-fetches threads at the start of every cycle (line 146), and that fetch now returns `id` as a native field of `ReviewThread`. Passing IDs through metadata would duplicate a value the handler already has and would go stale if the monitor's list differs from the handler's fresh view at cycle start (input-set closure is defined at cycle start, i.e., handler-side).

## 9. No change: `Comment`, `PullRequest`, `QueueItem`, `PrReviewEvent`

None of these carry thread-level state that changes as a result of this PR. Left unchanged.
