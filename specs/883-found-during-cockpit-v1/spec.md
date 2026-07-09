# Feature Specification: Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #37 — discovered on the PR-feedback loop's first successful end-to-end run (post-#878/#879 deploy)

**Branch**: `883-found-during-cockpit-v1` | **Date**: 2026-07-09 | **Status**: Draft

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #37 — discovered on the PR-feedback loop's first successful end-to-end run (post-#878/#879 deploy).

## Observed (christrudelpw/sniplink#4 / PR #14, 2026-07-09 10:52–11:04Z)

The loop's first cycle worked: 5 trusted unresolved threads → handler → Claude CLI (~3.6 min) → 4 files changed → commit `86d5f20` pushed → 5 thread replies ("I've addressed this feedback in the latest commit. Please review the changes.") → label cleared → success.

Then it did it again. And again:

- **Cycle 2** (claimed 10:56:57, ~22 s after cycle 1 completed): same 5 threads re-detected — **replies do not resolve threads**, and the monitor's trigger is `unresolvedThreads > 0`. Full CLI run (~2.2 min) → `No changes to commit — skipping commit/push` → **posted 10 more replies** (`threadCount: 10` — one per *comment*, including cycle 1's own replies) → success.
- **Cycle 3** enqueued 11:00:08 the moment cycle 2's item left in-flight. Operator's PR view at this point: three identical "I've addressed this feedback…" replies stacked on each thread and counting.

Nothing in the system can end this: the trigger state (unresolved threads) is one no code path transitions, so the loop re-fires at poll cadence forever — a full Claude CLI invocation plus a reply batch per ~5 minutes, with the reply batch growing each cycle (reply-per-comment: 5 → 10 → …). The #879 dedupe is working correctly throughout (drops while in-flight, structured `reason: "in-flight"` lines); this is not a dedupe bug — the *work generator* never terminates.

Manual intervention that stopped it (and proves the fix mechanism): resolved all 5 threads via `resolveReviewThread` GraphQL mutations using the cluster's own App credential — all succeeded. Next poll saw 0 unresolved; loop quiesced.

## Root cause

The handler treats "reply posted" as completing the feedback, but the monitor treats "thread unresolved" as feedback pending. Those are different state planes and the handler never writes to the one the monitor reads. A successful cycle must transition its own trigger.

## Proposal

1. **Resolve addressed threads.** After a fix cycle (changes pushed + reply posted), the handler resolves each thread it addressed via `resolveReviewThread` (add the thread `id` to the #861 `ReviewThread` shape; the App token can perform the mutation — verified live). Resolution is the termination edge *and* the correct semantic: "addressed, please verify." The operator re-opens the thread (or comments afresh) to re-trigger — a clean re-entry path. Note this does not conflict with #869 Q5-C's rejection of bot-resolution for the FR-004 *notice* (resolving there would have destroyed the operator's pending-feedback signal; resolving here IS the signal that fix work completed).
2. **No-change cycles must not act or claim success.** If the CLI produces no diff: post no replies, log `warn` that the trigger state persists unchanged, and exit without the success line — a cycle that neither changes the tree nor transitions the trigger is guaranteed to re-fire identically, i.e. it has proven the loop is stuck. (Cycle 2's behavior — 10 replies, unqualified success — is the amplifier.)
3. **Reply granularity: one reply per root thread**, never per comment — cycle 2 replied to cycle 1's replies, which is how the batch doubles each round.
4. **Termination invariant, stated in the contract:** every successful feedback cycle strictly decreases the unresolved-thread count. Anything else is a warn-level anomaly, not success.

## Regression tests

- Fix cycle: threads it replied to are resolved afterward; next monitor poll finds 0 unresolved; no re-enqueue (SC: comment count on the PR stops growing).
- No-diff cycle: no replies posted, no success log, `warn` emitted; label state untouched by that cycle.
- Replies target root comments only (fixture: thread with root + 2 replies → exactly one new reply).
- `resolveReviewThread` under an App installation token (recorded live 2026-07-09: 5/5 succeeded).


## User Stories

### US1: PR-feedback loop terminates on its own trigger

**As a** cluster operator watching a PR receive automated review-thread fixes,
**I want** each successful fix cycle to transition its own trigger state (thread → resolved) and each stuck cycle to visibly pause instead of silently churning,
**So that** the loop stops on its own after work is done, the operator never sees a duplicate "I've addressed this feedback" reply, and Claude CLI compute is not burned in ~5-minute increments forever on a state the handler cannot advance.

**Acceptance Criteria**:
- [ ] After a fix cycle pushes a commit, every trusted thread that was unresolved at cycle start is resolved via `resolveReviewThread` before the label is cleared.
- [ ] A subsequent monitor poll on the same PR sees `unresolvedThreads = 0` and does NOT re-enqueue the item.
- [ ] Each root thread receives exactly one bot reply per cycle (never one per comment); the reply text names the pushed commit SHA.
- [ ] A cycle whose CLI run produces no diff posts no replies, logs no success, emits a `warn` naming the persisting trigger, adds `blocked:stuck-feedback-loop`, and the monitor stops enqueueing until the operator clears the label.
- [ ] A persistently-failed `resolveReviewThread` mutation (after 3 retries) does NOT hold the whole cycle: if any resolution succeeded (unresolved count strictly decreased), the cycle logs success + clears the label + emits one `warn` per failed thread; the leftover thread flows into the no-diff/blocked disposition on the next cycle if the CLI produces no further diff.

### US2: Cockpit surfaces the blocked state

**As a** cluster operator running cockpit in auto mode,
**I want** `blocked:stuck-feedback-loop` (and any `blocked:*` label) surfaced by `cockpit watch` / `cockpit status` as an actionable escalation state,
**So that** a paused loop is never a silent strand — the operator sees "this needs your input" the moment the loop pauses itself.

**Acceptance Criteria**:
- [ ] `cockpit status` reports items carrying any `blocked:*` label as an actionable state (not "idle", not "in-progress").
- [ ] `cockpit watch` emits a transition line when a `blocked:*` label is added.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | On a successful fix cycle (CLI produced a diff → commit pushed), the handler MUST resolve, via `resolveReviewThread` under the App installation token, every trusted thread that was unresolved at cycle start (input-set closure). | P1 | Clarification Q2-A: input-set closure. Diff-locus intersection rejected (e.g., `zod` comment anchored at `lib/validation.ts:1` while fix landed in `package.json` would leave it stranded). |
| FR-002 | Each `resolveReviewThread` mutation that fails with a transient class of error MUST be retried synchronously up to 3 times with backoff (1s / 2s / 4s) before its outcome is treated as terminal. | P1 | Clarification Q1-C first pass. |
| FR-003 | A cycle whose CLI run produces no diff (nothing to commit) MUST NOT post replies, MUST NOT resolve any thread, MUST NOT log the success line, and MUST emit a `warn` naming the persisting trigger. | P1 | |
| FR-004 | On a no-diff cycle, the handler MUST leave `waiting-for:address-pr-feedback` in place (state is truthful), add `blocked:stuck-feedback-loop`, and the monitor MUST skip enqueueing while any `blocked:*` label is present. Operator removes `blocked:*` to permit another attempt. | P1 | Clarification Q3-B. |
| FR-005 | Reply granularity MUST be exactly one reply per root thread per cycle, never one per comment. Cycle-2's 10-replies-per-thread amplification is the direct target. | P1 | |
| FR-006 | Every cycle that logs success MUST strictly decrease the PR's unresolved-thread count. A cycle whose CLI diff produced a commit but whose resolve batch left the unresolved count unchanged MUST warn instead of logging success and MUST take the FR-004 blocked disposition. | P1 | Termination invariant. |
| FR-007 | Within a successful cycle, the handler MUST process addressed threads interleaved per-thread: for each thread, post the reply, then resolve it. The label-clear happens once at the end after all per-thread outcomes are counted. | P1 | Clarification Q4-C, reply→resolve within each thread — a reply without resolve is diagnosable and one click from fixed; a resolve without reply is silent completion. |
| FR-008 | The operator MUST be able to re-trigger a new cycle for a single thread by un-resolving it via the GitHub UI; the next monitor poll picks it up as an unresolved trusted thread. No agent-side plumbing beyond continuing to honor the monitor trigger. | P1 | Honest-disagreement channel. |
| FR-009 | Reply text on every cycle (first or re-triggered) MUST be the stateless, SHA-parameterized string: `"Addressed in <sha> — please review, and re-open this thread if it still falls short."` where `<sha>` is the short hash of the commit the handler just pushed. No cycle counter, no prior-reply lookup. | P2 | Clarification Q5, B-minus-counter. |
| FR-010 | On a partial-batch outcome — some `resolveReviewThread` calls persistently failed after FR-002 retries, but the unresolved count strictly decreased — the handler MUST log success, clear `waiting-for:address-pr-feedback`, and emit exactly one `warn` per persistently-failed thread naming the thread ID and the manual remedy (operator resolves in the UI, guided by the reply that is on the thread). | P1 | Clarification Q1 tail: strict-decrease is the sole success test after retries. |
| FR-011 | `blocked:*` labels MUST be treated by `cockpit watch` / `cockpit status` as actionable escalation-gate state (not "idle", not "in-progress"). | P2 | Clarification Q3 tail — a pause nobody surfaces is a strand. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | PR comment growth ceases after a successful fix cycle | Reply comment count on the target PR is stable across ≥3 subsequent monitor poll intervals with no operator action | Poll `gh api /repos/:o/:r/pulls/:n/comments` at t, t+poll, t+2·poll, t+3·poll after the success log; count MUST be unchanged. |
| SC-002 | No-diff cycles do not post replies | 0 new replies and 0 new commits produced by a cycle whose CLI run yielded no diff | Structured log inspection: cycle with `diff_files: 0` MUST show `replies_posted: 0`, `commits_pushed: 0`, `warn` line present, no success line. |
| SC-003 | Stuck loops pause visibly | A cycle that hits the FR-004 conditions ends with `blocked:stuck-feedback-loop` present on the PR AND no further enqueue for that PR at the next monitor poll | Inspect labels on the PR + monitor logs across one poll cycle after the blocked disposition. |
| SC-004 | Reply granularity is per-root-thread | On a PR with a thread that has root + N replies, one successful cycle produces exactly 1 new reply on that thread | Fixture PR with a thread of root + 2 replies; assert `+1 comment` on that thread after the cycle. |
| SC-005 | Partial resolve failure does not strand the loop | With `resolveReviewThread` injected to fail on 1 of N threads, the cycle logs success (strict decrease was met), clears the label, emits exactly 1 `warn` naming the failed thread | Injected-failure integration test on the handler. |
| SC-006 | `resolveReviewThread` works under the App installation token in production | 5/5 threads resolved in the observed cluster on 2026-07-09 (recorded); ongoing: ≥99% mutation success in production over the first 100 cycles post-deploy | Handler log grep + PR-side thread state inspection. |

## Assumptions

- The App installation token available to the cluster carries the scopes required to call `resolveReviewThread` on threads authored by any commenter on PRs in the target repo. (Verified live 2026-07-09: 5/5 succeeded on christrudelpw/sniplink#4.)
- The #861 `ReviewThread` shape is extended to expose the thread `id` (GitHub GraphQL node ID) needed by `resolveReviewThread`. If #861 does not yet expose it, this spec's implementation adds the field.
- The monitor treats `blocked:*` labels as a hard skip on enqueue — this is either an existing convention or is added in the same change; either way it lands with this spec.
- Un-resolving a thread from the GitHub UI causes the next monitor poll to re-observe it as unresolved and re-enqueue. (Consistent with today's trigger logic — this is the re-entry mechanism.)

## Out of Scope

- Refining the trusted-commenter set that gates thread inclusion (that was decided in prior work; this spec assumes it unchanged).
- Any change to CLI prompt or CLI-side logic — this spec is entirely about the handler's post-CLI behavior (reply / resolve / label / warn).
- Auto-un-resolution of threads the bot resolved (operator UI action is intentionally the re-entry channel per FR-008).
- Any redesign of the `waiting-for:address-pr-feedback` label semantics itself; this spec only adds a new `blocked:stuck-feedback-loop` sibling.
- Multi-repo or cross-PR coordination beyond the single-PR loop that misbehaved.

---

*Generated by speckit*
