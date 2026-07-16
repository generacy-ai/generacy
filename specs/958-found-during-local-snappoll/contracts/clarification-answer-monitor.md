# Contract: ClarificationAnswerMonitorService

## Purpose

Poll `waiting-for:clarification` + `agent:paused` issues. On a new human-authored comment, enqueue a resume queue item so the phase loop re-runs (which integrates on checkout). The gate deactivates naturally when `hasPendingClarifications === false`, or re-arms and pauses again if questions remain unparsed.

Mirrors `MergeConflictMonitorService`. Divergence from that reference must be explicit and named.

## Preconditions (per issue)

An issue is a candidate for enqueue iff **all** are true:

1. `waiting-for:clarification` is present.
2. `agent:paused` is present.
3. No `blocked:*` label is present.
4. Assigned to the cluster's GitHub username (via `filterByAssignee` — the same helper used by `MergeConflictMonitorService`).
5. At least one comment satisfies:
   - `viewerDidAuthor === false` (human-authored per D1 in research.md), AND
   - passes `isTrustedCommentAuthor(c, 'answer-scanner', trustCtx)` (same trust check the phase-loop scanner uses).

Comments carrying the answer-marker prefix are treated as cluster-self-authored regardless of `viewerDidAuthor` — they are not counted as new human comments.

## Post-conditions (on enqueue)

- One queue item pushed via `queueManager.enqueueIfAbsent(item)` with:
  - `owner`, `repo`, `issueNumber` — from the polled issue.
  - `workflowName` — resolved from `workflow:*` label, default `speckit-feature`.
  - `command: 'continue'`.
  - `queueReason: 'resume'`.
  - `priority: Date.now()`.
  - `enqueuedAt: new Date().toISOString()`.
- No labels are added or removed by the monitor.
- Structured log: `event: 'clarification-answer-resume-enqueued'`, includes owner/repo/issueNumber/source. Bodies never logged.

## Non-post-conditions (must NOT do)

- MUST NOT apply `completed:clarification`. That label is reserved for the human's explicit force-advance override (Q4 answer).
- MUST NOT modify `clarifications.md` — the monitor has no checkout; the phase loop (which does) performs integration.
- MUST NOT clear `waiting-for:clarification` or `agent:paused`. The worker owns those on the resume path (mirrors merge-conflict handling).
- MUST NOT subscribe to `issue_comment` webhooks. The monitor is authoritative (spec §Out of Scope).

## Dedupe (in-flight collision)

- `enqueueIfAbsent(item)` uses the `MergeConflictMonitorService` pattern (`packages/orchestrator/src/services/merge-conflict-monitor-service.ts` L171). If the item key `${owner}/${repo}#${issueNumber}` is already in the queue, returns `false` and the cycle is a silent no-op.
- No `phase-tracker:*:resume:*` key (deliberately absent — matches merge-conflict monitor).

## Poll cadence

- `pollIntervalMs`, `adaptivePolling`, `maxConcurrentPolls` from `PrMonitorConfig`.
- Adaptive polling: `ADAPTIVE_DIVISOR = 2` (matches merge-conflict monitor's Q divisor).
- `MIN_POLL_INTERVAL_MS = 10_000`.

## Failure handling

Copied verbatim from `MergeConflictMonitorService.pollRepo`:

- `JitTokenError` on `listIssuesWithLabel` → skip cycle, warn log, return.
- `GhAuthError` on `listIssuesWithLabel` → `authHealth.recordResult({ ok: false, statusCode })`, warn log, return.
- Any other error → warn log, return.
- Comment-fetch failure per issue → warn log, continue to next issue.

Auth health success: on successful list, `authHealth.recordResult({ ok: true })`.

## Wiring

- Constructor DI identical to `MergeConflictMonitorService`: `logger`, `createClient`, `queueManager`, `config`, `repositories`, `clusterGithubUsername?`, `tokenProvider?`, `authHealth?`, `githubAppCredentialId?`.
- Registered in `packages/orchestrator/src/services/index.ts` re-exports.
- Instantiated in `packages/orchestrator/src/server.ts` alongside the merge-conflict monitor, using the same DI arguments (except `config` — this monitor uses `config.prMonitor` for shared cadence, matching the merge-conflict monitor's split).
- `startPolling()` / `stopPolling()` registered in the same server lifecycle hooks.

## Interaction with FR-011 spec text

The spec says the monitor "enqueue[s] a resume queue item via `enqueueIfAbsent` (mirrors `MergeConflictMonitorService.enqueueIfAbsent` at `merge-conflict-monitor-service.ts` L113-169)." This contract is that exact contract. The spec's requirement that the monitor MUST NOT apply `completed:clarification` is codified here as a non-post-condition (top of file).

## Test coverage requirements

- Unit tests mirror `packages/orchestrator/src/services/__tests__/merge-conflict-monitor-service.test.ts`:
  - Precondition filtering (all five branches).
  - `enqueueIfAbsent` dedupe on repeated polls.
  - Blocked-label skip.
  - Assignee filter.
  - JitTokenError / GhAuthError branches.
  - Adaptive-polling cadence.
- Extension: comment-scan behavior — a comment with `viewerDidAuthor === true` (cluster-self) does not trigger enqueue; a `viewerDidAuthor === false` comment does.
- Integration: replay snappoll#7's fixture: bot posts 5 questions, no human reply → monitor does not enqueue any resume item; `waiting-for:clarification` retained; `phase:plan` never applied.
