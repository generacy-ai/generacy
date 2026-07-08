# Clarifications

## Batch 1 — 2026-07-08

### Q1: Client API shape
**Context**: FR-008 states a preference for a dedicated `getUnresolvedReviewThreads()` method over mutating `Comment.resolved` inside `getPRComments`, but marks the decision P2 and defers to clarifications. This decision drives the `Comment` type shape and all three call-site refactors (monitor, preflight, `read-pr-feedback`). Neither approach is fully specified: the dedicated-method approach still needs a way for `read-pr-feedback` to filter comments by thread resolution, and the mutation approach still needs to guarantee correct join semantics.
**Question**: Which client-side API shape should the fix adopt?
**Options**:
- A: Dedicated `getUnresolvedReviewThreads(owner, repo, number): Promise<{ rootCommentId: number; isResolved: boolean }[]>`, plus a second method (or extension) that returns `{ comments: Comment[]; resolvedThreadIds: Set<number> }` so `read-pr-feedback` can partition. `Comment.resolved` is removed from the type (breaking, but callers no longer read it directly).
- B: Keep `getPRComments()`'s existing signature but populate `Comment.resolved` truthfully by issuing a companion GraphQL call and joining by root comment ID. All call sites keep reading `c.resolved` — minimal diff.
- C: New `getPRReviewThreads(owner, repo, number): Promise<ReviewThread[]>` where `ReviewThread = { rootCommentId, isResolved, comments: Comment[] }`. `getPRComments()` deprecated; all three consumers migrate to the thread-shaped API.

**Answer**: C — thread-shaped `getPRReviewThreads(owner, repo, number): Promise<ReviewThread[]>` with `ReviewThread = { rootCommentId, isResolved, comments }`, and `getPRComments()` deprecated. Resolution is a property of threads, not comments; keeping a per-comment `resolved` boolean (B) preserves the exact type-shape that invited this bug, and A smears the thread/comment join logic across every consumer. All three call sites need touching regardless — migrate them to the honest model and the next consumer can't reintroduce the bug. Any caller that genuinely needs flat comments derives them via `threads.flatMap(t => t.comments)`.

### Q2: `preflight.unresolved_comments` semantics
**Context**: Under the fix, "unresolved" is a property of threads, not individual comments. Today's field name is `unresolved_comments` and the code counts filtered `Comment[]`. Spec's SC and FR don't specify whether the fixed field should count threads or comments-in-unresolved-threads.
**Question**: What should `preflight.unresolved_comments` count after the fix?
**Options**:
- A: Count of unresolved **threads** (root-level count that matches monitor's decision and GitHub UI's "N unresolved conversations"). Field kept for backward compat but semantically now a thread count.
- B: Count of **comments** (root + replies) belonging to unresolved threads. Preserves the literal meaning of the field name.
- C: Rename to `unresolved_threads` (thread count) — breaking downstream consumers that read the field, but honest naming.

**Answer**: C — rename to `unresolved_threads` (thread count, matching the monitor's decision and GitHub's "N unresolved conversations"). A field named `unresolved_comments` holding a thread count is a name that lies, and names that lie are how this smoke test's bug class happens. Rename every in-repo reader in the same PR; to my knowledge there are no cross-repo readers of this field — verify during plan, and fall back to A if one turns up.

### Q3: GraphQL failure / rate-limit fallback
**Context**: The monitor polls every ~60s. GraphQL adds a new failure surface (rate-limit, auth token missing thread-read scope, transient 5xx). Today's REST path silently returns zero enqueues on error; FR-005 pushes the zero-decision to `info` level but doesn't specify error behavior. Silent-continue reproduces the exact class of bug this issue fixes.
**Question**: When the GraphQL review-threads call fails, what should the monitor do?
**Options**:
- A: Log at `warn` level with `{ error, owner, repo, prNumber }` and skip enqueue for that cycle (no fallback). Next poll retries.
- B: Log at `error` level, skip enqueue, and **also** trigger the auth-health signal (like #762's `GhAuthError` path) so the cloud gets a `refresh-requested` event on 401s.
- C: Fall back to REST `Comment.resolved` (which is always `undefined`) and let the existing zero-match path fire. Preserves today's behavior on GraphQL outages.

**Answer**: B, scoped by failure class — auth-shaped failures (401/403) log at `error` and trigger the #762 `GhAuthError` auth-health path so the cloud gets a `refresh-requested` event; transient failures (5xx, rate-limit) log at `warn` with `{ error, owner, repo, prNumber }` and rely on the next poll cycle to retry. Never C — silently falling back to a field that is always `undefined` is precisely the bug being fixed.

### Q4: Info-log rate at ~60s poll cadence
**Context**: FR-005 requires the zero-unresolved decision to log at `info` (currently `debug`) with `{ totalComments, unresolvedThreads }`. At 60s poll intervals per monitored repo, this produces ~1440 log lines/day/PR at info level even when nothing is happening. On a cluster with many active PRs this dominates the log volume.
**Question**: How frequently should the info-level "no unresolved threads" line fire?
**Options**:
- A: Every poll cycle. Simplicity wins; operators can filter downstream. Matches spec's literal reading.
- B: Only on **state transitions** (unresolved→zero or count change). Steady-state polls stay at `debug`. Info fires when something meaningful happened.
- C: Every poll cycle, but only if `totalComments > 0`. Silent when the PR has no review comments at all; noisy when it has resolved-only threads.

**Answer**: B — info on state transitions only (unresolved→zero, or count change); steady-state polls stay at `debug`. 1,440 identical info lines/day/PR buries the signal, which is this issue's own failure mode applied to logs.

### Q5: Regression fixture source
**Context**: FR-006 requires "fixtures derived from a real REST payload (no `resolved` field present)" for the regression test. The spec doesn't say whether the fixture should be a **checked-in JSON file** captured from the live repro (`christrudelpw/sniplink#15`), a **generated stub** in test code that omits `resolved`, or something else. This affects both traceability and whether the fixture drifts as GitHub's payload shape evolves.
**Question**: How should the regression fixture be sourced and stored?
**Options**:
- A: Checked-in JSON file at `packages/orchestrator/src/services/__tests__/fixtures/pr-comments-rest.json` captured from the sniplink#15 live payload, with a comment header noting source PR + capture date. Test loads and asserts.
- B: Inline object literal in the test file that mirrors the REST shape but omits `resolved` — no separate fixture file, simpler diff, but no live-data provenance.
- C: Both — checked-in JSON for the monitor's regression test (auditable), inline literals for `preflight` and `read-pr-feedback` unit tests (concise).

**Answer**: C — both. The checked-in JSON captured from the christrudelpw/sniplink#15 live payload (with a header noting source PR + capture date) is the anti-"tests encode the code's assumptions" measure for the monitor regression test; inline literals keep the `preflight` and `read-pr-feedback` unit tests concise. Trim comment bodies in the captured payload to short placeholders — structure verbatim, content irrelevant.
