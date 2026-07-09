# Feature Specification: PR-Feedback Loop Termination via Thread Resolution

**Branch**: `883-found-during-cockpit-v1` | **Date**: 2026-07-09 | **Status**: Draft
**Source**: [generacy-ai/generacy#883](https://github.com/generacy-ai/generacy/issues/883)

## Summary

The PR-feedback loop's work generator never terminates. The monitor triggers on `unresolvedThreads > 0`; the handler completes a fix cycle by posting a reply — but posting a reply does not resolve a thread, so the trigger state persists and the loop re-fires every poll cycle. Each cycle burns a full Claude CLI invocation (~2–4 min) and posts one reply per *comment* in the thread (not per thread), so the reply batch doubles each round: 5 → 10 → 20 → …

Fix: the handler must resolve the threads it addressed (via GraphQL `resolveReviewThread`) as the terminating edge; no-change cycles must not post replies or claim success; replies must target root comments only; and every successful cycle must strictly decrease the unresolved-thread count as a stated contract invariant.

## Observed (christrudelpw/sniplink#4 / PR #14, 2026-07-09 10:52–11:04Z)

The loop's first cycle worked: 5 trusted unresolved threads → handler → Claude CLI (~3.6 min) → 4 files changed → commit `86d5f20` pushed → 5 thread replies ("I've addressed this feedback in the latest commit. Please review the changes.") → label cleared → success.

Then it did it again. And again:

- **Cycle 2** (claimed 10:56:57, ~22 s after cycle 1 completed): same 5 threads re-detected — replies do not resolve threads, and the monitor's trigger is `unresolvedThreads > 0`. Full CLI run (~2.2 min) → `No changes to commit — skipping commit/push` → **posted 10 more replies** (`threadCount: 10` — one per *comment*, including cycle 1's own replies) → success.
- **Cycle 3** enqueued 11:00:08 the moment cycle 2's item left in-flight. Operator's PR view at this point: three identical "I've addressed this feedback…" replies stacked on each thread and counting.

Nothing in the system can end this: the trigger state (unresolved threads) is one no code path transitions, so the loop re-fires at poll cadence forever. The #879 dedupe is working correctly (drops while in-flight, structured `reason: "in-flight"`); this is not a dedupe bug — the *work generator* never terminates.

Manual intervention that stopped it (and proves the fix mechanism): resolved all 5 threads via `resolveReviewThread` GraphQL mutations using the cluster's own App credential — all succeeded. Next poll saw 0 unresolved; loop quiesced.

## Root Cause

The handler treats "reply posted" as completing the feedback, but the monitor treats "thread unresolved" as feedback pending. Those are different state planes and the handler never writes to the one the monitor reads. A successful cycle must transition its own trigger.

Additionally, the reply loop iterates review *comments* rather than *threads*, so replies posted by a previous cycle become new comments that the next cycle re-replies to — turning drift into exponential amplification.

## User Stories

### US1: Operator waits for a bot fix without watching the loop churn

**As an** operator reviewing an in-progress PR the cluster is fixing,
**I want** the PR-feedback loop to stop after one successful cycle,
**So that** I can trust the bot's "addressed" reply and re-open the thread only if I actually disagree — instead of watching duplicate replies stack up while the cluster runs Claude CLI on a loop.

**Acceptance Criteria**:
- [ ] After a successful fix cycle, the addressed threads are marked resolved.
- [ ] The next monitor poll sees 0 unresolved threads and does not re-enqueue.
- [ ] Each thread receives exactly one reply per fix cycle.

### US2: Operator can re-trigger the loop by re-opening a thread

**As an** operator who is not satisfied with the bot's fix,
**I want** to re-trigger the loop by re-opening the resolved thread (or commenting fresh),
**So that** I have a clean, low-friction re-entry path that doesn't require dashboard actions or label toggling.

**Acceptance Criteria**:
- [ ] Un-resolving a previously-addressed thread makes the next monitor poll see it as unresolved and enqueue a new cycle.
- [ ] Un-resolving works via the standard GitHub PR UI (no cluster-side action needed).

### US3: Cluster does not waste compute on no-op cycles

**As a** cluster operator paying for Claude CLI invocations,
**I want** a cycle that produces no code changes to not post replies and not claim success,
**So that** the system logs the anomaly instead of masking a stuck loop as normal progress.

**Acceptance Criteria**:
- [ ] A CLI run producing no diff exits without posting replies.
- [ ] A no-change cycle emits a `warn` log entry naming the persisting trigger state.
- [ ] A no-change cycle does not emit the success log line.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                                                                     | Priority | Notes                                                              |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|--------------------------------------------------------------------|
| FR-001 | After a successful fix cycle (changes pushed AND reply posted), the handler MUST resolve each thread it addressed via GraphQL `resolveReviewThread`.                                                                                            | P1       | Terminating edge for the monitor's trigger.                        |
| FR-002 | The `ReviewThread` shape (from #861) MUST carry the thread's GraphQL `id` so the handler can pass it to `resolveReviewThread`.                                                                                                                  | P1       | Enabler for FR-001.                                                |
| FR-003 | If the Claude CLI run produces no diff, the handler MUST NOT post any replies.                                                                                                                                                                  | P1       | Prevents cycle-2 amplification.                                    |
| FR-004 | If the Claude CLI run produces no diff, the handler MUST NOT emit the success log line and MUST emit a `warn` log entry stating the trigger state persists unchanged.                                                                          | P1       | No-op cycle is a stuck-loop signal, not success.                    |
| FR-005 | The handler MUST post exactly one reply per unresolved *root thread* per cycle — never one per comment.                                                                                                                                         | P1       | Prevents replying to prior cycles' replies (exponential blowup).    |
| FR-006 | Every successful feedback cycle MUST strictly decrease the unresolved-thread count on the PR. A cycle that does not decrease the count is anomalous and MUST NOT log success.                                                                   | P1       | Termination invariant, stated in the handler contract.              |
| FR-007 | Thread resolution MUST use the cluster's own App installation token (already verified live 2026-07-09: 5/5 mutations succeeded).                                                                                                                | P1       | No new credential surface needed.                                   |
| FR-008 | Re-triggering: un-resolving a previously-addressed thread via the GitHub UI MUST cause the next monitor poll to see it as unresolved and enqueue a new cycle.                                                                                   | P2       | Clean re-entry path for dissatisfied operators.                     |

## Success Criteria

| ID     | Metric                                                                              | Target                                                                                             | Measurement                                                                                          |
|--------|-------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| SC-001 | PR-feedback loop terminates after one successful cycle.                             | 1 cycle → 0 unresolved threads → 0 re-enqueues.                                                     | Replay the sniplink#4 / PR#14 scenario in test fixture; assert monitor poll after cycle sees 0 unresolved. |
| SC-002 | Comment count on the PR stops growing after the fix cycle.                          | Reply count == thread count after cycle N; unchanged at cycle N+1.                                  | Count PR review comments before/after; assert no growth on subsequent polls.                        |
| SC-003 | No-change cycles do not post replies or claim success.                              | 0 replies posted, 0 success log lines, ≥1 `warn` log line naming the persisting trigger state.      | Fixture: force `git diff` empty; grep run log.                                                       |
| SC-004 | Reply granularity is one per root thread, regardless of how many comments the thread contains. | Fixture: thread with root + N replies → exactly 1 new reply posted.                                 | Unit test on reply iteration; live smoke test.                                                        |
| SC-005 | `resolveReviewThread` mutation succeeds under an App installation token.            | 100% success on well-formed thread IDs.                                                             | Live verification (already recorded 2026-07-09: 5/5); regression test with recorded fixture.        |

## Assumptions

- The GraphQL `resolveReviewThread` mutation is available under the cluster's GitHub App installation token with no additional permission grants (verified live 2026-07-09).
- The #861 `ReviewThread` shape can be extended with the thread's GraphQL `id` field without breaking downstream consumers.
- Re-opening a resolved thread via the GitHub UI is an acceptable UX for re-triggering the loop.
- The #879 dedupe logic is correct and requires no changes.

## Out of Scope

- Any change to the #879 dedupe path — dedupe is working correctly; this fix targets the work generator.
- Bot-resolution of the FR-004 *notice* thread from #869 (Q5-C explicitly rejected bot-resolution there because it destroys the operator's pending-feedback signal). This spec's thread resolution is a distinct case: it IS the signal that fix work completed.
- Any change to the monitor's trigger definition (`unresolvedThreads > 0`) — the fix is in the handler transitioning the trigger, not redefining it.
- Non-GraphQL fallback paths for thread resolution — the App token has verified access; no fallback needed.

## Regression Tests

- **Fix cycle terminates**: threads replied to are resolved afterward; next monitor poll finds 0 unresolved; no re-enqueue (SC-001, SC-002).
- **No-diff cycle**: no replies posted, no success log, `warn` emitted; label state untouched by that cycle (SC-003).
- **Reply granularity**: fixture with a thread containing root + 2 replies → exactly one new reply on the root (SC-004).
- **`resolveReviewThread` under App installation token**: recorded fixture matching live 2026-07-09 verification (SC-005).

---

*Generated by speckit*
