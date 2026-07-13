# Implementation Plan: PR-feedback loop terminates on its own trigger (#883)

**Feature**: Make the PR-feedback loop end its own trigger — resolve every trusted-unresolved thread at cycle start after a successful fix cycle; refuse to reply or claim success on no-diff cycles; reply once per root thread, never per comment; surface stuck loops via a new `blocked:stuck-feedback-loop` label the monitor honors and cockpit classifies.
**Branch**: `883-found-during-cockpit-v1`
**Status**: Complete

## Summary

The observed loop churn on `christrudelpw/sniplink#4` proved a state-plane mismatch: the handler treats "reply posted" as termination while the monitor treats "thread unresolved" as pending. A successful cycle never writes to the plane the monitor reads, so `unresolvedThreads > 0` re-fires forever, doubling the reply batch each round (5 → 10 → 20 …). The manual remedy that stopped it — running `resolveReviewThread` under the App token — proves the fix mechanism and confirms scope.

This PR:

1. **Extends the `ReviewThread` shape (#861) with the GraphQL node `id`** so the handler can call `resolveReviewThread`.
2. **Adds `GitHubClient.resolveReviewThread(threadId)`** with bounded synchronous retries (Q1-C: 3 tries, 1s/2s/4s backoff) built into the method.
3. **Restructures the handler's post-CLI batch to interleaved reply→resolve per root thread** (Q4-C), collapses reply granularity to one-reply-per-root-thread (FR-005), and interpolates the pushed commit SHA into the reply body (Q5, B-minus-counter).
4. **Applies strict-decrease as the sole success test** after retries (Q1 tail / FR-006 / FR-010): ≥1 resolve success → log success, clear `waiting-for:address-pr-feedback`, emit one `warn` per persistently-failed thread; 0 successes (including no-diff cycles) → FR-004 blocked disposition.
5. **Introduces `blocked:stuck-feedback-loop`** as a new workflow label. Handler adds it on the no-diff / no-decrease branch; monitor skips enqueueing while ANY `blocked:*` label is present on the linked issue (Q3-B).
6. **Teaches the cockpit classifier** that `blocked:*` maps to the `waiting` tier and sorts ahead of every `waiting-for:*` gate in `WAITING_PIPELINE_ORDER` (FR-011) — so `cockpit status` and `cockpit watch` surface the pause as actionable.

FR-008 (operator un-resolves in the UI to re-trigger) needs zero agent-side plumbing: today's monitor already re-observes un-resolved threads on the next poll and re-enqueues (subject to #879 in-flight dedupe and the new `blocked:*` skip).

## Technical Context

- **Language**: TypeScript (strict), ESM, Node ≥22
- **Packages touched**: `@generacy-ai/workflow-engine`, `@generacy-ai/orchestrator`, `@generacy-ai/cockpit`
- **Runtime dependencies**: `gh` CLI (existing) for both the GraphQL mutation and the REST reply POST
- **No new packages, no new dependencies**
- **GitHub GraphQL mutation used**: `resolveReviewThread(input: { threadId: ID! }) { thread { id isResolved } }`. The App installation token already has the scope needed on the target repo (verified live 2026-07-09, 5/5 mutations succeeded on `christrudelpw/sniplink#4`).
- **Interaction with #879 in-flight dedupe**: unchanged. The `blocked:*` skip lives in the monitor's pre-enqueue phase (before `enqueueIfAbsent` is called), so `blocked:*` and in-flight dedupe cannot compete.
- **Interaction with #869 zero-trusted branch**: unchanged. Zero-trusted → posts the untrusted notice, does not enqueue. The `blocked:*` skip is an independent, additional pre-enqueue gate.

## Project Structure

Changes span three packages. All modifications sit alongside existing patterns; no new modules are introduced beyond a small helper for the retry loop.

```
packages/workflow-engine/src/
├── types/
│   └── github.ts                                     [MODIFY] Add `id: string` to `ReviewThread` (assumption in spec)
├── actions/github/client/
│   ├── interface.ts                                  [MODIFY] Add `resolveReviewThread(threadId: string): Promise<void>` to `GitHubClient`
│   └── gh-cli.ts                                     [MODIFY] Extend `getPRReviewThreads` query to select `id`, populate `ReviewThread.id`; add `resolveReviewThread` method with 3-try backoff (1s/2s/4s) around `gh api graphql`
├── actions/github/
│   └── label-definitions.ts                          [MODIFY] Append `blocked:stuck-feedback-loop` to WORKFLOW_LABELS

packages/orchestrator/src/
├── worker/
│   └── pr-feedback-handler.ts                        [MODIFY] Core rewrite (see §Handler restructure below)
├── services/
│   └── pr-feedback-monitor-service.ts                [MODIFY] Pre-enqueue `blocked:*` skip; refresh `lastUnresolvedThreadCount` state for the skipped case

packages/cockpit/src/
├── state/
│   ├── label-map.ts                                  [MODIFY] Add `blocked:*` → 'waiting' branch in `classifyByPattern`
│   └── precedence.ts                                 [MODIFY] Prepend `blocked:stuck-feedback-loop` to `WAITING_PIPELINE_ORDER` (highest priority within `waiting` tier)

specs/883-found-during-cockpit-v1/
├── spec.md                                           [read-only]
├── clarifications.md                                 [read-only]
├── plan.md                                           [THIS FILE]
├── research.md                                       [ADD]
├── data-model.md                                     [ADD]
├── quickstart.md                                     [ADD]
└── contracts/
    ├── resolve-review-thread.md                      [ADD]  GraphQL mutation shape + retry semantics
    ├── handler-fix-cycle.md                          [ADD]  Reply/resolve/label-clear ordering + outcome matrix
    └── monitor-blocked-skip.md                       [ADD]  Pre-enqueue skip on any `blocked:*` label
```

**Files NOT changing:**

- `packages/orchestrator/src/services/pr-linker.ts` — link semantics unchanged; still returns assignees, not labels. Handler and monitor fetch labels via `client.getIssue(...)` on their own.
- `packages/orchestrator/src/types/monitor.ts` — `PrFeedbackMetadata.reviewThreadIds` (root comment IDs) stays. Thread node IDs are consumed handler-side from the fresh GraphQL fetch, not threaded through metadata (handler re-fetches at start of cycle already; that fetch now returns `id` too).
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` PR-linker branch, trust filter, zero-trusted notice, #879 in-flight dedupe — untouched.
- `packages/generacy/src/cli/commands/cockpit/watch.ts` / `status.ts` — delegate classification to `@generacy-ai/cockpit`. The new `blocked:*` behavior flows from label-map + precedence changes; no CLI-side branch is required.

## Handler restructure (`pr-feedback-handler.ts`)

The rewrite lives in the existing `handle()` method's post-CLI section (lines 262 onward) plus `replyToThreads` (line 596). The pre-CLI branches (getPR → switch branch → fetch threads → author-trust filter → prompt build → CLI spawn) are unchanged.

**New shape of the post-CLI batch:**

```
// step 6: CLI has completed (success | timeout | failure)

// step 7: commit + push (existing; returns hasChanges: boolean)
const hasChanges = await commitAndPushChanges(...)

// step 7a: no-diff / no-CLI-success disposition (FR-003, FR-004)
if (!success || !hasChanges) {
  logger.warn({ prNumber, issueNumber, trigger: 'unresolvedThreads>0', reason: !success ? 'cli-did-not-complete' : 'no-diff' },
              'no-diff cycle — persisting trigger, entering blocked-stuck-feedback-loop disposition')
  await github.addLabels(owner, repo, issueNumber, [BLOCKED_STUCK_FEEDBACK_LOOP_LABEL])   // add blocked:*
  // leave waiting-for:address-pr-feedback in place (Q3-B, truthful state)
  // do NOT post replies, do NOT resolve, do NOT log success
  return
}

// step 7b: happy path — CLI succeeded AND we have a real commit
const shortSha = (await github.getHeadShortSha(checkoutPath)) ?? '<unknown>'   // short SHA of the just-pushed commit

// step 8: interleaved reply→resolve per root thread (Q4-C, FR-005, FR-007)
//   inputSet = trustedUnresolvedThreads at cycle start (already computed; input-set closure per Q2-A)
const outcomes: PerThreadOutcome[] = []
for (const thread of trustedUnresolvedThreads) {
  const replyBody = `Addressed in ${shortSha} — please review, and re-open this thread if it still falls short.`
  const replyResult = await tryPostReply(github, owner, repo, prNumber, thread.rootCommentId, replyBody)
  const resolveResult = await tryResolveReviewThread(github, thread.id)   // uses built-in 3× retry
  outcomes.push({ threadId: thread.id, rootCommentId: thread.rootCommentId, replyResult, resolveResult })
}

// step 9: strict-decrease success test (FR-006, FR-010)
const resolveSuccesses = outcomes.filter(o => o.resolveResult.ok).length
const resolveFailures  = outcomes.filter(o => !o.resolveResult.ok)

if (resolveSuccesses === 0) {
  // FR-006 tail — commit landed but no thread transitioned. Take the FR-004 blocked disposition.
  logger.warn({ prNumber, issueNumber, outcomes }, 'commit pushed but resolve batch had zero successes — persisting trigger, entering blocked-stuck-feedback-loop disposition')
  await github.addLabels(owner, repo, issueNumber, [BLOCKED_STUCK_FEEDBACK_LOOP_LABEL])
  return
}

// success line + one warn per persistently-failed thread (FR-010)
for (const f of resolveFailures) {
  logger.warn({ prNumber, issueNumber, threadId: f.threadId, rootCommentId: f.rootCommentId, error: f.resolveResult.error, remedy: 'Resolve the thread manually in the GitHub UI — the reply is already on the thread' },
              'resolveReviewThread persistently failed after retries; label will still be cleared')
}
await removeFeedbackLabel(github, owner, repo, issueNumber)   // step 10 — label-clear LAST (Q4 tail)
logger.info({ prNumber, issueNumber, resolveSuccesses, resolveFailures: resolveFailures.length, shortSha }, 'PR feedback cycle succeeded (strict decrease met)')
```

**Structural notes:**

- `replyToThreads` (loops over `comments`) is deleted. Its replacement is inline in the loop above and takes `thread.rootCommentId`, so a thread with root + 2 replies gets exactly one new reply (SC-004).
- `tryPostReply` and `tryResolveReviewThread` are small helpers in `pr-feedback-handler.ts` returning `{ ok: true } | { ok: false, error: string }`. `tryResolveReviewThread` delegates to `github.resolveReviewThread`, which owns the 3× retry — the helper never retries.
- `github.getHeadShortSha(checkoutPath)` is either an existing method or added (thin wrapper over `git rev-parse --short HEAD`). If it fails, the reply body falls back to `<unknown>` — SHA is decoration, not termination logic.
- Reply-then-resolve within a single thread (Q4-C tail): if the reply succeeds but resolve fails permanently, the operator sees the "Addressed in <sha>" reply and one click resolves the thread. If the reply fails, resolve is still attempted (silent-completion risk is the lesser evil vs. leaving both un-done).

## Monitor pre-enqueue skip (`pr-feedback-monitor-service.ts`)

Insertion point: between **Case A: at least one thread is trust-live** (line 308) and the `addLabels(waiting-for:address-pr-feedback)` call (line 328).

```
// Case A tail: check for any blocked:* label on the linked issue before enqueue (FR-004 tail).
const issueLabels = await client.getIssueLabels(owner, repo, issueNumber)   // small new call OR reuse existing getIssue
const blockedLabel = issueLabels.find(l => l.startsWith('blocked:'))
if (blockedLabel) {
  logger.info(
    { owner, repo, issueNumber, prNumber, blockedLabel, unresolvedThreads: unresolvedThreadIds.length, reason: 'blocked-label-present' },
    'Skipping PR-feedback enqueue while blocked:* label is present'
  )
  this.lastUnresolvedThreadCount.set(stateKey, unresolvedThreadIds.length)   // keep the map fresh so the next transition still logs cleanly
  return false
}
```

**Notes:**

- The check happens AFTER trust filtering but BEFORE `addLabels(waiting-for:address-pr-feedback)` and the queue-manager call. Rationale: `waiting-for:address-pr-feedback` should not be re-added while the operator has already paused the loop; leaving it in place if already present is fine (idempotent add is a no-op), but we don't want to add it fresh on a currently-blocked issue.
- The `getIssueLabels` (or equivalent) call adds one API request per polled PR that is trust-live. If perf becomes an issue we can hoist it into a batch call, but at v1 poll cadence this is negligible.
- The check is at the monitor level, not the queue-adapter level, so `blocked:*` on an issue whose PR-feedback has NOT reached Case A (e.g., zero-trusted) does not affect the untrusted-notice path — that path is orthogonal.

## Cockpit classifier changes

**`packages/cockpit/src/state/label-map.ts`** — extend `classifyByPattern` (currently line 29):

```
if (label.startsWith('waiting-for:') || label.startsWith('needs:') || label.startsWith('blocked:')) return 'waiting';
```

`LABEL_TO_STATE` is built at module load by iterating `WORKFLOW_LABELS`. Because we're adding `blocked:stuck-feedback-loop` to `WORKFLOW_LABELS`, the map picks it up automatically; the fallback branch at the bottom of `mapLabelToState` (`?? 'unknown'`) still handles unknown labels correctly. Any future `blocked:*` addition to `WORKFLOW_LABELS` will inherit the same tier without further changes.

**`packages/cockpit/src/state/precedence.ts`** — prepend `blocked:stuck-feedback-loop` to `WAITING_PIPELINE_ORDER`:

```
export const WAITING_PIPELINE_ORDER: string[] = [
  'blocked:stuck-feedback-loop',                     // NEW: highest priority within `waiting` tier
  'waiting-for:spec-review',
  'waiting-for:clarification',
  ...
];
```

Effect: when an issue carries both `waiting-for:address-pr-feedback` AND `blocked:stuck-feedback-loop`, the classifier's `waiting`-tier tie-break picks `blocked:stuck-feedback-loop` as `sourceLabel`. `cockpit status` renders it in the state column; `cockpit watch` emits a transition line when the label is added because `sourceLabel` changes.

FR-011 is satisfied as-is: the existing `waiting` tier is already "not idle, not in-progress" (idle == pending / unknown; in-progress == active). No new tier is introduced; no CLI or config change is needed to make cockpit surface the blocked state.

## Rollout notes

- **No config / no migration required.** The `blocked:stuck-feedback-loop` label is created on-demand via `github.addLabels(...)`; sync-labels (`WORKFLOW_LABELS`-driven) will also create it on the next repo sync. Neither is a blocker.
- **Backwards compatibility of `ReviewThread.id`**: the field is added as required. All in-tree callers of `getPRReviewThreads` (the handler and the monitor) consume `ReviewThread` from the same fetch site. Tests that build `ReviewThread` fixtures need the field. No wire compatibility risk (this is an internal type).
- **App token scope for `resolveReviewThread`**: verified live 2026-07-09 (5/5 mutations succeeded). No new grant is needed; if a cluster ever hits a 403 on the mutation, that thread's outcome falls into `resolveFailures` and the operator sees the FR-010 warn with a one-click remedy.
- **#869 zero-trusted notice branch is untouched**: FR-004's `blocked:*` is a distinct, later-in-flow signal for the stuck-fix-loop case, not a replacement for the untrusted notice.

## Constitution check

No project-level constitution file (`.specify/memory/constitution.md`) exists in this repo. No cross-repo constitution applies to this handler change. Cross-check against implicit project conventions:

- **Zod-only schema validation** for external inputs — n/a here (GraphQL response parsing is hand-written; retry loop consumes strings and returns booleans).
- **No secret in logs** — `resolveReviewThread` never logs the token; `github.resolveReviewThread` inherits the standard `gh api graphql` invocation which reads `GH_TOKEN` from env.
- **Fail-loud on internal boundary errors** — the handler's outer `try/catch` retains its `throw` behavior for the pre-CLI section; the new post-CLI batch converts per-thread failures into warns (per Q1 tail) but keeps a hard `throw` for anything above (fetching threads, spawning CLI, git operations).
- **No new dependencies** — confirmed.

## Suggested next step

`/speckit:tasks` to generate the task list from this plan.
