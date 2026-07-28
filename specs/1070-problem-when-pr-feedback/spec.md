# Feature Specification: Distinguish PR-feedback fixer timeout from stuck-loop, and let it self-recover

**Branch**: `1070-problem-when-pr-feedback` | **Date**: 2026-07-28 | **Status**: Draft
**Source**: [generacy#1070](https://github.com/generacy-ai/generacy/issues/1070)

## Summary

When the PR-feedback fixer CLI hits its 20-minute timeout after already pushing a partial commit, `PrFeedbackHandler` mislabels the outcome as `blocked:stuck-feedback-loop`, emits a log line that contradicts its own payload (`msg: "Successfully pushed changes"` + `success: false`), and the label it just applied blocks the very re-dispatch that would finish the work. Observed 2026-07-28 on generacy#1060 / PR #1065: the fixer pushed a correct 20-file commit addressing all six review findings, then stalled forever because nothing was ever "looping" — the fixer simply ran out of budget one step short of the reply/resolve loop.

This spec covers three narrowly-scoped fixes to `packages/orchestrator/src/worker/pr-feedback-handler.ts` and `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`:

1. Split the timeout disposition off from the no-diff / no-progress disposition and give it its own label (`blocked:fixer-timeout`).
2. Correct the log line at `pr-feedback-handler.ts:453` so the message matches its payload.
3. Allow **one bounded automatic re-dispatch** when the previous disposition was `blocked:fixer-timeout` **and** the previous cycle produced a real commit — after which, if the second attempt also times out, escalate to a distinct human-only label.

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

### US2: A single automatic retry finishes near-complete work unattended (Priority: P1)

**As an** operator running a long-lived cluster,
**I want** a timed-out fixer cycle that already pushed a real commit to get **one** automatic re-dispatch,
**So that** a review that legitimately needs slightly more than 20 minutes doesn't require a human to babysit the next tick.

**Acceptance criteria**
- [ ] When `blocked:fixer-timeout` is present **and** the previous cycle pushed at least one commit onto the PR branch, the monitor re-dispatches exactly once, removing `blocked:fixer-timeout` at dispatch time.
- [ ] If that retry also times out (`exitCode: 143`), the handler applies a distinct terminal label `blocked:fixer-timeout-repeat`. The monitor's existing `blocked:*` short-circuit at `pr-feedback-monitor-service.ts:378-388` keeps that terminal state paused with no further retries.
- [ ] If the retry succeeds (Disposition A path — reply + resolve), no residual `blocked:*` label remains.
- [ ] If the retry cleanly exits without a diff (`success && !hasChanges`), the handler applies `blocked:stuck-feedback-loop` (the retry made no progress → matches the label's semantics).

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
| FR-001 | `PrFeedbackHandler` MUST expose a distinct disposition for CLI timeout — the branch condition MUST be `!success && timedOut` at minimum, and MUST NOT be folded into the `!hasChanges` branch. | P1 | Splits `pr-feedback-handler.ts:469-481` into three explicit sub-branches: `timeout`, `no-diff`, `push-failed`. |
| FR-002 | Introduce label `blocked:fixer-timeout` with description "PR-feedback CLI timed out (exit 143) — one automatic retry will follow if a commit was pushed." | P1 | New entry in `label-definitions.ts` next to line 111. |
| FR-003 | Introduce label `blocked:fixer-timeout-repeat` with description "PR-feedback CLI timed out twice in a row — human intervention required." | P1 | Terminal state for the bounded retry. Same file. |
| FR-004 | Retain `blocked:stuck-feedback-loop` with its current description and current apply-site behavior — it MUST only be applied when `success === true && !hasChanges` (no forward progress at all) or when Disposition B's resolve batch had zero successes. | P1 | Preserves back-compat with the cockpit consumer test at `e2e-address-pr-feedback.test.ts:119`. |
| FR-005 | The log at `pr-feedback-handler.ts:453` MUST NOT emit when `success === false`. On the timeout path, emit a separate `warn`-level line naming the partial push explicitly. | P2 | Message must not begin with "Successfully" when `success: false` appears in the payload. |
| FR-006 | The monitor at `pr-feedback-monitor-service.ts:365-390` MUST recognize `blocked:fixer-timeout` as a **retry-eligible** blocked state — exactly once per PR-branch head SHA — and MUST remove the label before enqueuing. | P1 | The head-SHA scope prevents infinite retry on a genuinely stuck PR: if the retry produces a new commit, the SHA changes and the retry counter re-enables on a subsequent legitimate timeout at that new SHA. If the retry produces no new commit and times out again, the second timeout lands on the same SHA and applies `blocked:fixer-timeout-repeat`. |
| FR-007 | The handler MUST detect a second consecutive timeout on the same branch head SHA and apply `blocked:fixer-timeout-repeat` instead of `blocked:fixer-timeout`. | P1 | Requires reading the branch's tip SHA once at cycle start and comparing to the SHA recorded at the previous timeout (persistence mechanism deferred to /plan). |
| FR-008 | On the retry path (label was `blocked:fixer-timeout`, monitor re-dispatched), the fresh fixer prompt MUST be identical to a fresh cycle's prompt — the retry does NOT get special instructions or trimmed input. | P2 | Keeps the handler's prompt-building path single and testable. The retry is "same input, more time." |
| FR-009 | Disposition C (body-finding gate, `pr-feedback-handler.ts:566-591`) semantics are unchanged. | P1 | Explicit non-goal — this spec does not touch `blocked:body-finding-unaddressed`. |
| FR-010 | The `finally`-block clear of `agent:in-progress` (existing behavior, #926) MUST fire on all three new disposition branches. | P1 | Prevents a timed-out cycle from stranding `agent:in-progress`. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | A timed-out fixer cycle that pushed a real commit is labelled distinctly from a no-diff cycle. | 100% of timeout paths | grep worker logs for `disposition: 'fixer-timeout'`; verify label on issue. |
| SC-002 | A single timed-out cycle with a pushed commit self-recovers without human action when the second cycle finishes in-budget. | 1 successful auto-retry, then reply+resolve loop runs. | Integration test: mock CLI to time out first invocation, succeed second. Assert `blocked:*` labels all removed, threads resolved. |
| SC-003 | Two consecutive timeouts on the same branch head SHA halt with a distinct terminal label. | `blocked:fixer-timeout-repeat` present; monitor logs `Skipping PR-feedback enqueue` on next poll. | Integration test: mock CLI to time out twice in a row against a branch whose SHA doesn't advance between calls. |
| SC-004 | Any log line at `pr-feedback-handler.ts:453` has a payload with `success: true`. | 100% grep audit. | Static test: grep the fixed source for `'Successfully pushed'` and assert it's guarded by `if (hasChanges && success)`. |
| SC-005 | The `blocked:stuck-feedback-loop` cockpit consumer test at `e2e-address-pr-feedback.test.ts:119` still passes unmodified. | Test passes. | Run existing test suite. |
| SC-006 | No new persisted state is required outside the existing monitor state (`MonitorState`, Redis keys under `orchestrator:queue:*`). | 0 new Redis key patterns; 0 new files under `/var/lib/generacy/`. | Code review; grep. |

## Assumptions

1. The CLI-timeout detection at `pr-feedback-handler.ts:785-792` correctly identifies SIGTERM via `timedOut === true && exitCode === 143`; this spec does not re-derive the timeout condition, only forks the downstream disposition on it.
2. `commitAndPushChanges` remains the sole source of truth for `hasChanges` (i.e., a `true` value guarantees a commit landed on the remote branch, `false` guarantees no push occurred).
3. The retry budget is exactly one — this is not a general "N-retry" mechanism. If the second attempt also times out, the operator's next step is to shrink the review scope, not to keep trying.
4. Branch-head-SHA scoping (FR-006, FR-007) is the sufficient invariant to prevent infinite retry: the SHA changes iff a commit lands; a commit landing means real progress; real progress "spends" the retry-once budget at the new SHA. The retry-once budget resets naturally at each new SHA.
5. The monitor's existing `blocked:*` short-circuit at `pr-feedback-monitor-service.ts:378-388` remains the sole enqueue gate. The retry path in FR-006 is implemented as a **narrower check that fires before the `blocked:*` short-circuit**, not as an allow-list carve-out inside it. This preserves the invariant that any unrecognized `blocked:*` label pauses the monitor.
6. Cockpit consumer semantics: `blocked:fixer-timeout` and `blocked:fixer-timeout-repeat` are new blocked-state labels; cockpit's existing "any `blocked:*` outranks address-pr-feedback" logic already handles them correctly by prefix. No cockpit-side change is expected. (Verify at /plan.)

## Out of Scope

- Extending the retry budget beyond one (a general N-retry framework).
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

*Initial spec — run `/speckit:clarify` to resolve ambiguities (in particular: FR-006/FR-007 persistence mechanism for the "same head SHA" test; FR-008 confirmation that a fresh prompt is desirable).*
