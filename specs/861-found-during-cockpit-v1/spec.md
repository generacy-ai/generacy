# Feature Specification: Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #26 — and the correction of an earlier misread: the address-pr-feedback loop has NEVER functioned

**Branch**: `861-found-during-cockpit-v1` | **Date**: 2026-07-08 | **Status**: Draft

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #26 — and the correction of an earlier misread: the address-pr-feedback loop has NEVER functioned. Two request-changes rounds were posted on christrudelpw/sniplink PR #15 (3 inline threads July 7, 1 more July 8, all unresolved); the monitor logged "Processing PR review event from poll" every cycle and silently enqueued nothing either time.

Root cause: `GhCliClient.getPRComments` (workflow-engine gh-cli.ts:441-467) projects REST `/repos/{owner}/{repo}/pulls/{n}/comments`, whose payload has NO `resolved` field — thread resolution exists only in GraphQL (`pullRequest.reviewThreads.isResolved`). So `Comment.resolved` is undefined on every comment ever fetched, and:
- PrFeedbackMonitorService's filter `c.resolved === false && !c.in_reply_to_id` matches nothing, ever — both poll AND webhook paths route through this same function, so the entire feedback-addressing flow is unreachable. The zero-match exit logs at debug ("No unresolved review threads — skipping"), invisible at info level, which hid this for two rounds.
- preflight.ts:213's `unresolvedComments` count is permanently 0.
- read-pr-feedback.ts:59's `c.resolved !== true` filter accidentally passes everything — its unresolved-only mode is a no-op.

Three consumers, zero producers. Tests mocked Comment fixtures WITH `resolved: false` — the assumption-encoding pattern's sixth instance in this test (#800, #826, #836, #853, #855).

Fix: source resolution truthfully — a GraphQL query on `pullRequest.reviewThreads` (isResolved + first comment databaseId) exposed via a new thread-shaped client method `getPRReviewThreads(owner, repo, number): Promise<ReviewThread[]>` where `ReviewThread = { rootCommentId, isResolved, comments: Comment[] }`. `getPRComments()` is deprecated and all three consumers (monitor, preflight, read-pr-feedback) migrate to the thread-shaped API in the same PR (Q1→C). `preflight.unresolved_comments` is renamed to `unresolved_threads` and holds a thread count matching the monitor's decision and GitHub's "N unresolved conversations" (Q2→C). Also promote the monitor's zero-unresolved exit to `info` with `{ totalComments, unresolvedThreads }`, but fire it **only on state transitions** (unresolved→zero or count change) — steady-state polls stay at `debug` (Q4→B). GraphQL failure handling is scoped by class: auth-shaped failures (401/403) log at `error` and trigger the #762 `GhAuthError` auth-health path so the cloud emits `refresh-requested`; transient failures (5xx, rate-limit) log at `warn` with `{ error, owner, repo, prNumber }` and rely on the next poll cycle to retry — no silent REST fallback (Q3→B). Regression fixtures: a checked-in JSON file at `packages/orchestrator/src/services/__tests__/fixtures/pr-comments-rest.json` captured from the sniplink#15 live payload (header noting source PR + capture date, comment bodies trimmed to placeholders — structure verbatim, content irrelevant) drives the monitor regression test; `preflight` and `read-pr-feedback` unit tests use inline literals (Q5→C).

Live repro: christrudelpw/sniplink PR #15 — four unresolved threads visible in the UI, monitor polling it every ~60s, nothing enqueued.

## Clarifications Resolved

- **Q1 (API shape) → C**: New `getPRReviewThreads(owner, repo, number): Promise<ReviewThread[]>` returning `{ rootCommentId, isResolved, comments }`. `getPRComments()` deprecated; monitor, preflight, and read-pr-feedback all migrate. Callers needing flat comments derive via `threads.flatMap(t => t.comments)`. `Comment.resolved` removed.
- **Q2 (preflight field) → C**: Rename `preflight.unresolved_comments` → `unresolved_threads` (thread count). Rename every in-repo reader in the same PR; verify during plan that no cross-repo readers exist (fall back to A if one turns up).
- **Q3 (GraphQL failure) → B, scoped by failure class**: Auth-shaped (401/403) → log `error` + fire `GhAuthError` auth-health signal (#762). Transient (5xx, rate-limit) → log `warn` with `{ error, owner, repo, prNumber }`, no fallback, next poll retries. Never fall back to the always-`undefined` REST field.
- **Q4 (info-log rate) → B**: Info fires only on state transitions (unresolved→zero or count change). Steady-state polls stay at `debug`.
- **Q5 (fixture source) → C**: Checked-in JSON at `packages/orchestrator/src/services/__tests__/fixtures/pr-comments-rest.json` (captured from sniplink#15, header with source PR + capture date, comment bodies trimmed to placeholders) for the monitor regression test. Inline object literals for the `preflight` and `read-pr-feedback` unit tests.


## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
