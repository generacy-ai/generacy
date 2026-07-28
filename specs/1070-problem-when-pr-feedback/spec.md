# Feature Specification: Distinguish PR-feedback fixer timeout from stuck-loop, and let it self-recover

**Branch**: `1070-problem-when-pr-feedback` | **Date**: 2026-07-28 | **Status**: Draft
**Source**: [generacy#1070](https://github.com/generacy-ai/generacy/issues/1070)

## Summary

When the PR-feedback fixer CLI hits its 20-minute timeout after already pushing a partial commit, `PrFeedbackHandler` mislabels the outcome as `blocked:stuck-feedback-loop`, emits a log line that contradicts its own payload (`msg: "Successfully pushed changes"` + `success: false`), and the label it just applied blocks the very re-dispatch that would finish the work. Observed 2026-07-28 on generacy#1060 / PR #1065: the fixer pushed a correct 20-file commit addressing all six review findings, then stalled forever because nothing was ever "looping" — the fixer simply ran out of budget one step short of the reply/resolve loop.

This spec covers three narrowly-scoped fixes to `packages/orchestrator/src/worker/pr-feedback-handler.ts` and `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`:

1. Split the timeout disposition off from the no-diff / no-progress disposition and give it its own labels:
   - `blocked:fixer-timeout` (timeout with a pushed commit — retry-eligible),
   - `blocked:fixer-timeout-no-progress` (timeout with zero commits pushed — terminal, human-only, per clarification Q3=C), and
   - `blocked:fixer-timeout-repeat` (auto-retry budget reached — terminal, human-only).
2. Correct the log line at `pr-feedback-handler.ts:453` so the message matches its payload.
3. Allow **up to two bounded automatic re-dispatches per PR-feedback trigger** (per clarification Q5=C) when the previous disposition was `blocked:fixer-timeout` **and** the previous cycle produced a real commit. The budget is a small integer counter keyed by `stateKey`, resets **only when all review threads are fully resolved** (i.e., the work actually completed), and — when exhausted — escalates to `blocked:fixer-timeout-repeat`. Zero-commit timeouts do NOT consume a retry (they land on `blocked:fixer-timeout-no-progress` immediately).

## Problem statement (verbatim from #1070)

Worker log excerpt, in order:

```
Staging and committing changes          staged:0 unstaged:18 untracked:2
Pushing changes to PR branch
Successfully pushed changes
Successfully pushed changes to PR branch          success: false      <-- (a)
CLI timed out — returning false to trigger partial completion strategy
                                        exitCode: 143  timeoutMs: 1200000
no-diff cycle — persisting trigger, entering blocked-stuck-feedback-loop
                                        reason: "cli-did-not-complete" <-- (b)
```

Three defects, all reproducible in-source today:

- **(a)** `pr-feedback-handler.ts:451-454` emits `'Successfully pushed changes to PR branch'` **inside** the `if (hasChanges)` branch with `success` (the CLI-exit boolean) in the payload. When the CLI timed out, `success === false` — the msg still reads "Successfully".
- **(b)** `pr-feedback-handler.ts:469-481` collapses `!success || !hasChanges` into a single branch and applies `blocked:stuck-feedback-loop`. The label documented at `label-definitions.ts:111` reads *"last cycle could not advance the trigger"* — but the fixer here pushed a 20-file commit that addressed all findings; the only unfinished step was the reply/resolve bookkeeping.
- **(c)** `pr-feedback-monitor-service.ts:378-388` short-circuits any pre-enqueue check with `'Skipping PR-feedback enqueue while blocked:* label is present'` on **any** `blocked:*` label. With `blocked:stuck-feedback-loop` set by (b), the trigger persists in state but is never re-dispatched. No retry, no backoff, no escalation.

## User Stories

### US1: Operator can distinguish a timeout from a stuck loop (Priority: P1)

**As an** operator triaging a paused PR-feedback cycle,
**I want** the label on the issue to name the actual failure mode,
**So that** I can act on it without re-reading the worker log to figure out whether the fixer ran out of time (retry candidate) or genuinely cannot make progress (needs human intervention).

**Acceptance criteria**
- [ ] When the CLI exits from a timeout (SIGTERM, `exitCode: 143`), the handler applies `blocked:fixer-timeout`, not `blocked:stuck-feedback-loop`.
- [ ] When the CLI exits cleanly (`success === true`) but produced no diff, the handler applies `blocked:stuck-feedback-loop` (unchanged from today).
- [ ] The two labels are documented in `label-definitions.ts` with descriptions that reflect their actual triggers.
- [ ] The Disposition B log line names which of the two branches was taken (field `disposition: 'fixer-timeout' | 'no-diff'`).

### US2: Up to two automatic retries finish near-complete work unattended (Priority: P1)

**As an** operator running a long-lived cluster,
**I want** a timed-out fixer cycle that already pushed a real commit to get **up to two** automatic re-dispatches (per clarification Q5=C),
**So that** a review that legitimately needs multiple 20-minute windows doesn't require a human to babysit each tick — while a genuinely wedged fixer that keeps timing out without finishing the work still halts after a bounded number of attempts.

**Acceptance criteria**
- [ ] When `blocked:fixer-timeout` is present **and** the previous cycle pushed at least one commit onto the PR branch **and** the per-`stateKey` retry counter has not reached the limit (2), the monitor re-dispatches, removing `blocked:fixer-timeout` at dispatch time and incrementing the counter.
- [ ] If a retry also times out with a commit push, the counter increments again. When the counter reaches its limit and yet another timeout follows, the handler applies the distinct terminal label `blocked:fixer-timeout-repeat`. The monitor's existing `blocked:*` short-circuit at `pr-feedback-monitor-service.ts:378-388` keeps that terminal state paused with no further retries.
- [ ] If any retry succeeds and all review threads are fully resolved (Disposition A path — reply + resolve completes), no residual `blocked:*` label remains **and** the counter is cleared. A fresh timeout on the same PR later gets the full retry budget again.
- [ ] If a retry cleanly exits without a diff (`success && !hasChanges`), the handler applies `blocked:stuck-feedback-loop` (the retry made no progress → matches the label's semantics). The counter is NOT cleared in this case (the trigger is not "done").
- [ ] `waiting-for:address-pr-feedback` remains present across the entire retry chain (per clarification Q4=A) — the monitor re-adds it as usual; the retry dispatch does not clear it. This closes the "review silently dropped while `waiting-for:*` is absent" failure mode.

### US3: Log messages match their payloads (Priority: P2)

**As an** operator grepping worker logs for a PR number,
**I want** the human-readable message to reflect the same outcome as the structured fields on the same line,
**So that** a top-to-bottom read of the log doesn't contradict a field-level read.

**Acceptance criteria**
- [ ] The line at `pr-feedback-handler.ts:453` is only emitted when both `hasChanges === true` **and** `success === true`.
- [ ] When `hasChanges === true && success === false` (timeout after partial push), the line reads something like `'Pushed partial changes before CLI timed out'` and the payload does not include `success` (or names it `cliCompleted: false`).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `PrFeedbackHandler` MUST expose a distinct disposition for CLI timeout — the branch condition MUST be `timedOut === true` at minimum, and MUST NOT be folded into the `!hasChanges` branch. | P1 | Splits `pr-feedback-handler.ts:469-481` into four explicit sub-branches: `timeout-with-changes`, `timeout-no-progress`, `no-diff`, `push-failed` (per clarification Q3=C — timeout-no-progress gets its own terminal label rather than reusing `blocked:stuck-feedback-loop`). |
| FR-002 | Introduce label `blocked:fixer-timeout` with description "PR-feedback CLI timed out (exit 143) after pushing a partial commit — up to two automatic retries will follow." | P1 | New entry in `label-definitions.ts` next to line 111. |
| FR-002a | Introduce label `blocked:fixer-timeout-no-progress` with description "PR-feedback CLI timed out (exit 143) without pushing any commit — human intervention required (retries would not make progress)." | P1 | New entry in `label-definitions.ts`. Terminal state per clarification Q3=C. Reject alternative of collapsing this into `blocked:stuck-feedback-loop`: it re-introduces this issue's exact naming bug (label names the wrong cause). |
| FR-003 | Introduce label `blocked:fixer-timeout-repeat` with description "PR-feedback CLI timed out and the auto-retry budget (2) was exhausted without fully resolving review threads — human intervention required." | P1 | Terminal state for the bounded retry. Same file. |
| FR-004 | Retain `blocked:stuck-feedback-loop` with its current description and current apply-site behavior — it MUST only be applied when `success === true && !hasChanges` (no forward progress at all) or when Disposition B's resolve batch had zero successes. | P1 | Preserves back-compat with the cockpit consumer test at `e2e-address-pr-feedback.test.ts:119`. |
| FR-005 | The log at `pr-feedback-handler.ts:453` MUST NOT emit when `success === false`. On the timeout path, emit a separate `warn`-level line naming the partial push explicitly. | P2 | Message must not begin with "Successfully" when `success: false` appears in the payload. |
| FR-006 | The monitor at `pr-feedback-monitor-service.ts:365-390` MUST recognize `blocked:fixer-timeout` as a **retry-eligible** blocked state — for up to two dispatches per `stateKey`, tracked by an in-memory `Map<stateKey, retryCount>` on `PrFeedbackMonitorService` (per clarifications Q1=A + Q5=C, mirroring the sibling `lastUnresolvedThreadCount` map at `pr-feedback-monitor-service.ts:79`) — and MUST remove the `blocked:fixer-timeout` label before enqueuing. The retry-eligible check MUST fire **before** the `blocked:*` short-circuit (per Assumption 5). | P1 | Counter is process-local (survives poll ticks, forgets on restart). Counter is NOT keyed by branch head SHA — the earlier SHA-scoping wording was overturned by Q5=C because a cycle that writes one trivial commit advances the SHA and refills a SHA-keyed budget, producing an unbounded chain the fixer cannot terminate (a fixer that times out never reaches the no-diff branch). |
| FR-007 | When the handler emits a timeout disposition and `hasChanges === true`, it MUST check the current retry counter for the `stateKey`. If the counter has reached its limit (2), apply `blocked:fixer-timeout-repeat` instead of `blocked:fixer-timeout`. | P1 | Handler reads the same in-memory counter the monitor writes (via constructor injection or a shared reference — mechanism deferred to /plan). Counter reset happens on Disposition A completion (all threads resolved) — see FR-013. |
| FR-008 | On the retry path (label was `blocked:fixer-timeout`, monitor re-dispatched), the fresh fixer prompt MUST be identical to a fresh cycle's prompt — the retry does NOT get special instructions or trimmed input. | P2 | Keeps the handler's prompt-building path single and testable. The retry is "same input, more time." |
| FR-009 | Disposition C (body-finding gate, `pr-feedback-handler.ts:566-591`) semantics are unchanged. | P1 | Explicit non-goal — this spec does not touch `blocked:body-finding-unaddressed`. |
| FR-010 | The `finally`-block clear of `agent:in-progress` (existing behavior, #926) MUST fire on all four new disposition branches. | P1 | Prevents a timed-out cycle from stranding `agent:in-progress`. |
| FR-011 | `spawnClaudeForFeedback` (`pr-feedback-handler.ts:412`) MUST change its return type from `Promise<boolean>` to `Promise<{ success: boolean; exitCode: number \| null; timedOut: boolean }>` (per clarification Q2=B). The `timedOut` and `exitCode` fields must be plumbed through `runCli` (`pr-feedback-handler.ts:759-791`) so the disposition logic in `handleAddressPrFeedback` can distinguish timeout from a clean non-zero exit and log `exitCode` authoritatively. | P1 | Rejected: keeping a boolean return and stashing `timedOut` on `this` (hidden temporal coupling); emitting an event/callback (over-engineered for a two-caller path). Test doubles at `pr-feedback-handler.test.ts` update in the same PR. |
| FR-012 | On the `blocked:fixer-timeout` disposition (retry-eligible timeout), the handler MUST leave `waiting-for:address-pr-feedback` in place (per clarification Q4=A). The monitor's usual `waiting-for:*` re-add on next dispatch is a no-op. | P1 | Load-bearing: any window in which `waiting-for:*` / `agent:*` is absent is a window in which an incoming review is silently dropped. Rejected: clearing and letting the monitor re-add (opens a race gap); clearing and not re-adding (requires the monitor to special-case retry dispatch, more code for less clarity). |
| FR-013 | The retry counter MUST reset when Disposition A completes successfully (all review threads resolved). The counter MUST NOT reset on any of: no-diff cycle (`blocked:stuck-feedback-loop`), timeout-no-progress (`blocked:fixer-timeout-no-progress`), or push-failed. | P1 | Per clarification Q5=C — the only condition that legitimately clears the budget is "the work actually completed", not "some commit landed" (which is what caused the unbounded-chain edge case). |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | A timed-out fixer cycle that pushed a real commit is labelled distinctly from a no-diff cycle. | 100% of timeout paths | grep worker logs for `disposition: 'fixer-timeout'`; verify label on issue. |
| SC-002 | A single timed-out cycle with a pushed commit self-recovers without human action when the second cycle finishes in-budget. | 1 successful auto-retry, then reply+resolve loop runs. | Integration test: mock CLI to time out first invocation, succeed second. Assert `blocked:*` labels all removed, threads resolved. |
| SC-003 | Three timeout dispositions on the same `stateKey` without a Disposition A success in between halt with a distinct terminal label. | `blocked:fixer-timeout-repeat` present after the third timeout; monitor logs `Skipping PR-feedback enqueue` on next poll. | Integration test: mock CLI to time out three times in a row (each with a pushed commit so retry-eligibility holds); assert `blocked:fixer-timeout` on cycles 1 and 2, `blocked:fixer-timeout-repeat` on cycle 3, no further enqueue after that. |
| SC-003a | A timeout with zero commits pushed halts immediately with a distinct terminal label (no retry). | `blocked:fixer-timeout-no-progress` present; monitor logs `Skipping PR-feedback enqueue` on next poll. | Integration test: mock CLI to time out on the very first cycle with `hasChanges === false`; assert `blocked:fixer-timeout-no-progress`, retry counter unchanged, no further enqueue. |
| SC-003b | The retry counter resets after a successful Disposition A completion. | After cycles `[timeout-with-push, timeout-with-push, success-with-full-resolve, timeout-with-push, timeout-with-push, timeout-with-push]` the terminal `blocked:fixer-timeout-repeat` appears on the sixth cycle, not the fourth. | Integration test as described. |
| SC-004 | Any log line at `pr-feedback-handler.ts:453` has a payload with `success: true`. | 100% grep audit. | Static test: grep the fixed source for `'Successfully pushed'` and assert it's guarded by `if (hasChanges && success)`. |
| SC-005 | The `blocked:stuck-feedback-loop` cockpit consumer test at `e2e-address-pr-feedback.test.ts:119` still passes unmodified. | Test passes. | Run existing test suite. |
| SC-006 | No new persisted state is required outside the existing monitor state (`MonitorState`, Redis keys under `orchestrator:queue:*`). | 0 new Redis key patterns; 0 new files under `/var/lib/generacy/`. | Code review; grep. |

## Assumptions

1. The CLI-timeout detection at `pr-feedback-handler.ts:785-792` correctly identifies SIGTERM via `timedOut === true && exitCode === 143`; this spec does not re-derive the timeout condition, only forks the downstream disposition on it.
2. `commitAndPushChanges` remains the sole source of truth for `hasChanges` (i.e., a `true` value guarantees a commit landed on the remote branch, `false` guarantees no push occurred).
3. The retry budget is exactly two per `stateKey` (per clarification Q5=C) — this is not a general "N-retry" mechanism, but it is not the strictly-one budget the initial draft assumed. Two windows accommodates the observed field failure (large review, one legitimate slow cycle) while remaining bounded. Reset is progress-only: full thread resolution clears the counter; a bare commit does not (see Assumption 4).
4. **Counter-scoped budget, reset on completion** (per clarification Q5=C, supersedes the initial "same head SHA" framing): the retry budget is a small integer counter keyed by `stateKey`, stored in an in-memory `Map` on `PrFeedbackMonitorService` (per clarification Q1=A). The counter increments on each `blocked:fixer-timeout` dispatch and resets **only** when Disposition A completes (all review threads fully resolved). A SHA-keyed budget was rejected because a fixer that times out never reaches the no-diff branch — every timeout cycle that writes any commit at all would advance the SHA and refill the budget, producing an unbounded loop the fixer cannot escape.
5. The monitor's existing `blocked:*` short-circuit at `pr-feedback-monitor-service.ts:378-388` remains the sole enqueue gate. The retry path in FR-006 is implemented as a **narrower check that fires before the `blocked:*` short-circuit**, not as an allow-list carve-out inside it. This preserves the invariant that any unrecognized `blocked:*` label pauses the monitor.
6. Cockpit consumer semantics: `blocked:fixer-timeout`, `blocked:fixer-timeout-no-progress`, and `blocked:fixer-timeout-repeat` are new blocked-state labels; cockpit's existing "any `blocked:*` outranks address-pr-feedback" logic already handles them correctly by prefix. No cockpit-side change is expected. (Verify at /plan.)
7. In-memory counter loss on orchestrator restart is an accepted failure mode (per clarification Q1=A). A restart between two timeouts grants at most the retry cap again — one or two extra 20-min cycles, only if unresolved threads still exist — which is strictly better than today's permanent wedge. If restart-loss ever proves too lossy in practice, the escalation path is Q1's option B (marker-comment on the PR body, gated on `blocked:fixer-timeout*` being present so the normal path stays free), not options C (label-name-as-storage) or D (Redis; SC-006-forbidden).

## Out of Scope

- Extending the retry budget beyond two (a general N-retry framework).
- Changing the 20-minute CLI timeout (`config.phaseTimeoutMs`).
- Modifying the fixer prompt on retry (per FR-008 — retry uses the identical prompt).
- Touching `blocked:body-finding-unaddressed` / Disposition C behavior (FR-009).
- Adding a cockpit-side observer for the new labels — expected to work via prefix.
- Changing `agent:in-progress` clear semantics (#926 stays as-is; FR-010 is a preservation, not a change).
- Auto-retry on **non-timeout** failure modes (e.g., `push-failed`, `resolve-batch-zero-successes`) — those remain human-only per today's behavior.

## Provenance

Found while driving generacy#1060 to merge on 2026-07-28. PR #1065's partial push (`79cb7888`, 20 files) was complete and correct — all six review findings addressed. Only the reply/resolve bookkeeping was missing. Manual resolve worked first try, confirming this was never a permissions or rate-limit problem: the fixer simply timed out one step short of the bookkeeping loop.

Operator diagnostic (from #1070): grep worker logs for `exitCode: 143` before believing the fixer is stuck.

```
docker logs --since 45m tetrad-development-worker-N | grep <prNumber>
```

Only one worker handles a given PR.

---

*Clarify phase complete (batch 1, 2026-07-28): all five ambiguities resolved on generacy#1070. Load-bearing decisions integrated above — Q1=A (in-memory `Map` on `PrFeedbackMonitorService`), Q2=B (widen `spawnClaudeForFeedback` return type), Q3=C (distinct `blocked:fixer-timeout-no-progress` label), Q4=A (keep `waiting-for:address-pr-feedback` across retry), Q5=C (counter-scoped budget max 2, reset only on full thread resolution). Q5 rewrote the retry-budget model from SHA-keyed one-shot to counter-keyed up-to-two with progress-based reset.*
