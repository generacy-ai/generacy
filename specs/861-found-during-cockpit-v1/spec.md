# Feature Specification: PR-feedback loop never fires — `Comment.resolved` never populated

**Branch**: `861-found-during-cockpit-v1` | **Date**: 2026-07-08 | **Status**: Draft
**Source**: [generacy-ai/generacy#861](https://github.com/generacy-ai/generacy/issues/861) — cockpit v1 smoke test finding #26

## Summary

`GhCliClient.getPRComments` (`packages/workflow-engine/src/actions/github/client/gh-cli.ts:441-472`) reads REST `/repos/{owner}/{repo}/pulls/{n}/comments`, whose payload does **not** include a `resolved` field. Thread resolution is only exposed via GraphQL (`pullRequest.reviewThreads.isResolved`). Every `Comment.resolved` value returned by this client is therefore `undefined`. Three downstream consumers depend on that field:

1. `PrFeedbackMonitorService` (`packages/orchestrator/src/services/pr-feedback-monitor-service.ts:166`) filters with `c.resolved === false && !c.in_reply_to_id`. **Zero matches, ever.** Poll and webhook paths both route through this filter, so the entire "address-pr-feedback" gate has never fired. The zero-match branch exits at `debug` level with message `"No unresolved review threads — skipping"` — invisible at default `info` level, which is why the bug survived two request-changes rounds on `christrudelpw/sniplink#15` (3 threads on 2026-07-07, 1 more on 2026-07-08, all unresolved; monitor polled every ~60s, enqueued nothing).
2. `preflight.ts:213` — `unresolvedComments = comments.filter(c => c.resolved === false).length` — permanently reports `0` in preflight metadata.
3. `read-pr-feedback.ts:59` — `comments = allComments.filter(c => c.resolved !== true)` — inverse mistake: `undefined !== true` is `true`, so this filter passes every comment, silently converting "unresolved only" mode into a no-op.

Three consumers, zero producers. Existing tests mocked `Comment` fixtures **with** `resolved: false` set explicitly (the sixth instance of the "test fixture encodes the bug's assumption" pattern in this codebase — cf. #800, #826, #836, #853, #855), so the test suite passed while production was broken from day one.

## User Stories

### US1: Cluster addresses a reviewer's request-changes without human intervention

**As a** developer whose PR was reviewed by a human reviewer,
**I want** the cluster's monitor to detect unresolved review threads and enqueue the address-pr-feedback workflow,
**So that** requested changes are handled by the agent instead of the PR stalling silently.

**Acceptance Criteria**:
- [ ] Given a PR with N unresolved review threads (as visible in the GitHub UI), the monitor detects exactly N unresolved thread IDs on its next poll.
- [ ] Given a PR whose review threads have all been resolved via the GitHub UI, the monitor detects zero unresolved threads and does not enqueue.
- [ ] Replies within an unresolved thread are not counted as separate root-level threads.
- [ ] The monitor's per-poll decision is visible at `info` level with counts (`totalComments`, `unresolvedThreads`), so an operator watching logs can confirm the monitor is working on live PRs.

### US2: `read-pr-feedback` action's `include_resolved=false` mode actually filters

**As a** workflow author using `github.read_pr_feedback` with `include_resolved=false`,
**I want** only unresolved comments returned,
**So that** the agent isn't handed already-addressed feedback.

**Acceptance Criteria**:
- [ ] With `include_resolved=false`, comments belonging to resolved threads are excluded from the returned list.
- [ ] With `include_resolved=true`, all comments are returned regardless of thread state.
- [ ] `unresolved_count` in the action output matches the count visible in the GitHub UI.

### US3: `preflight` reports accurate `unresolved_comments` count

**As a** workflow gate that consumes preflight metadata,
**I want** `unresolved_comments` to reflect the true unresolved thread count,
**So that** downstream decisions gated on "are there open review threads?" are correct.

**Acceptance Criteria**:
- [ ] `unresolved_comments` field in preflight output equals the count of unresolved root threads visible in the GitHub UI.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                                                | Priority | Notes |
|--------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|-------|
| FR-001 | The GitHub client MUST source review-thread resolution state from GraphQL `pullRequest.reviewThreads.isResolved` — the REST `/pulls/{n}/comments` endpoint MUST NOT be relied on for resolution state.                       | P1       | Root fix |
| FR-002 | `PrFeedbackMonitorService` MUST identify unresolved root-level threads and enqueue address-pr-feedback for each poll cycle where any exist.                                                                                  | P1       | US1 |
| FR-003 | `read-pr-feedback` action MUST honor `include_resolved=false` by excluding comments in resolved threads from the returned list.                                                                                              | P1       | US2 |
| FR-004 | `preflight.ts` MUST populate `unresolved_comments` from a truthful resolution source.                                                                                                                                        | P1       | US3 |
| FR-005 | The monitor's zero-unresolved decision MUST log at `info` level (not `debug`), with structured fields `{ totalComments, unresolvedThreads }`, so live-data behavior is observable at the default log level.                  | P1       | Prevents next silent regression |
| FR-006 | Regression tests MUST use fixtures derived from a **real** REST payload (no `resolved` field present). Pre-fix, the test MUST reproduce zero enqueues on a PR with unresolved threads. Post-fix, the test MUST enqueue correctly. | P1       | Blocks the "fixture-encoded-assumption" pattern |
| FR-007 | The GraphQL query MUST map thread resolution back onto the root comment IDs that `PrFeedbackMonitorService.unresolvedThreadIds` currently consumes, so the monitor's downstream contract with `PrFeedbackHandler` is preserved. | P1       | Interface compatibility |
| FR-008 | Solution SHOULD prefer a dedicated `getUnresolvedReviewThreads(owner, repo, number)` method returning root comment IDs (monitor's only need), migrating `preflight` and `read-pr-feedback` in the same pass, over silently mutating `Comment.resolved` inside `getPRComments`. | P2       | Design preference — see clarifications |

## Success Criteria

| ID     | Metric                                                                                                        | Target                                          | Measurement |
|--------|---------------------------------------------------------------------------------------------------------------|-------------------------------------------------|-------------|
| SC-001 | On live repro `christrudelpw/sniplink#15` with 4 unresolved threads, monitor enqueues address-pr-feedback     | ≥1 enqueue within one poll cycle (~60s)         | Watch orchestrator logs + queue for the enqueue event |
| SC-002 | Regression test using real REST payload fixture                                                                | Pre-fix: 0 enqueues. Post-fix: N enqueues where N = unresolved thread count in fixture | vitest — asserts on `unresolvedThreadIds.length` |
| SC-003 | `read-pr-feedback` with `include_resolved=false` on a PR with mixed resolved/unresolved threads                | Returned comments contain only unresolved threads' comments | Contract test with GraphQL mock |
| SC-004 | Zero-unresolved decision visible in `info`-level logs                                                          | Log line matches `/No unresolved review threads/` with `{ totalComments, unresolvedThreads }` fields at `info` | Grep monitor log at info level |
| SC-005 | Grep for `c.resolved === false`, `c.resolved !== true`, `c.resolved === true` in `packages/orchestrator` and `packages/workflow-engine` (excluding tests) | Zero matches — no consumer reads a field that has no producer | `Grep` in CI |

## Assumptions

- The `gh api graphql` CLI subcommand is available in the same `gh` binary the client already shells out to, so no new dependency is required.
- Review threads have a single "root" comment identifiable by `databaseId` in GraphQL, and this maps 1:1 to the REST `id` field. (Confirmed by GitHub API docs — GraphQL `databaseId` equals REST `id`.)
- The `PrFeedbackHandler` downstream contract (consumes root comment IDs from unresolved threads) does not change; only the source of resolution state changes.
- The 2026-07-07 / 2026-07-08 request-changes rounds on `christrudelpw/sniplink#15` remain unresolved in the UI and can be used to validate the fix against real data.

## Out of Scope

- Rewriting the entire `GhCliClient` to use GraphQL — only the resolution-state read is being fixed here.
- Changing `Comment` type shape beyond what's needed to carry resolution truthfully (or removing `resolved` from `Comment` entirely if the dedicated-method design is chosen; that's a downstream cleanup).
- Migrating the `resolveConversation` reply path — this issue is strictly about **reading** resolution state.
- Retroactively addressing the four unresolved threads on `christrudelpw/sniplink#15`. The fix will handle them on the next poll after deploy; no manual replay needed.
- Fixing the broader "test fixtures encoding the bug's own assumption" anti-pattern (#800, #826, #836, #853, #855) — tracked separately.

## Related Issues / References

- Cockpit v1 smoke test parent: `generacy-ai/tetrad-development#88`, finding #26.
- Live repro: `christrudelpw/sniplink#15`.
- Prior "fixture-encoded-assumption" instances: #800, #826, #836, #853, #855.
- Files at the center of the bug:
  - `packages/workflow-engine/src/actions/github/client/gh-cli.ts:441-472` — `getPRComments`
  - `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:161-183` — monitor filter + debug-level exit
  - `packages/workflow-engine/src/actions/github/preflight.ts:206-213` — preflight unresolved count
  - `packages/workflow-engine/src/actions/github/read-pr-feedback.ts:54-59` — inverted filter no-op
  - `packages/workflow-engine/src/types/github.ts:82,350` — `Comment.resolved?: boolean` (the field with no producer)

---

*Generated by speckit*
