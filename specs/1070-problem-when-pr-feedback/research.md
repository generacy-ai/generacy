# Research: Distinguish PR-feedback fixer timeout from stuck-loop

**Branch**: `1070-problem-when-pr-feedback` | **Issue**: [generacy#1070](https://github.com/generacy-ai/generacy/issues/1070) | **Companion**: [clarifications.md](./clarifications.md)

Load-bearing decisions this PR takes, with rationale and rejected alternatives. Each decision maps 1:1 to a clarification answer plus (for the two `/plan`-time discoveries) an explicit call-out.

## Decision 1 — Widen `spawnClaudeForFeedback` return type (Q2=B)

**Chosen**: `Promise<{ success: boolean; exitCode: number | null; timedOut: boolean }>`.

**Rationale**: The defect that produced this issue was *diagnosed* by reading `exitCode: 143` from a worker log line — the timeout signal is already stringly-typed in the same payload the handler is about to render. Making `exitCode` and `timedOut` first-class in the return value costs one type change and pays back at every disposition-logging site in the handler for the life of the code. `exitCode` in particular saves the future reader from re-deriving "was this a timeout" from a boolean.

**Rejected**:
- **Q2=A** (return `{ success, timedOut }`, drop `exitCode`) — YAGNI-adjacent but fails the "make the diagnostic signal first-class" test the field-observed bug motivates. Would need widening again the first time an operator asks "what was the exit code" and grepping shows only debug-level logs carrying it.
- **Q2=C** (keep boolean return, expose `timedOut` as a mutable field on `this`) — hidden temporal coupling. The option's own text concedes it is harder to test. Rejected outright per clarification Q2 answer.
- **Q2=D** (event/callback) — over-engineered for a two-caller private method.

**Sources**:
- `packages/orchestrator/src/worker/pr-feedback-handler.ts:412` (call site) and `:687` (definition).
- `packages/orchestrator/src/worker/pr-feedback-handler.ts:757-791` (runCli internals — `timedOut` already exists as a local, `exitCode` is already awaited).
- Existing test doubles at `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts` will require signature updates (~5 sites).

## Decision 2 — Counter storage: in-memory `Map` on `PrFeedbackMonitorService` (Q1=A)

**Chosen**: A new `private fixerTimeoutRetryCount: Map<string, number>` field on `PrFeedbackMonitorService`, mirroring the shape of the sibling `lastUnresolvedThreadCount` map at `pr-feedback-monitor-service.ts:79`.

**Rationale**:
- Zero additional GitHub API calls per poll. This is load-bearing: cluster and operator share a 5000/hr GitHub budget, and a per-poll GraphQL read is exactly the shape that produced recent `/cockpit:auto` rate-limit exhaustion.
- Structural sibling to existing state maps → reviewers already understand the pattern.
- Restart-loss failure mode is bounded and benign: an orchestrator restart between two timeouts grants at most the Q5 cap again (one or two extra 20-min cycles, only if unresolved threads still exist). Strictly better than today's permanent wedge.

**Rejected**:
- **Q1=B** (marker comment on the PR body via `listPrCommentBodies`) — durable across restart, matches the #1047 acknowledgment-marker pattern, but adds one GitHub read per poll. Kept as documented escalation path if Q1=A restart-loss ever proves too lossy in practice (spec §Assumption 7).
- **Q1=C** (encode counter in label name, e.g., `blocked:fixer-timeout-2`) — unbounded label proliferation in shared repo namespace; harder for humans to remove correctly (they'd have to guess the numeric suffix).
- **Q1=D** (Redis key under `orchestrator:pr-feedback:timeout-count:*`) — cleanest in isolation but violates SC-006's "0 new Redis key patterns" wording. Would require rewording that success criterion.

**Sources**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:79` (sibling pattern), `packages/orchestrator/src/types/monitor.ts:187-198` (MonitorState — no per-issue slot to piggyback on).

## Decision 3 — Handler↔monitor counter transport: QueueItem metadata (/plan-time — spec-deferred)

**Chosen**: A new `retryAttempt: number` field on `PrFeedbackMetadata` (`packages/orchestrator/src/types/monitor.ts:38-43`). The monitor writes it at enqueue; the handler reads it at cycle start.

**Rationale**: Decision 2 chose the monitor as the counter's owner, but the handler runs in a **different process** in worker mode. `packages/orchestrator/src/server.ts:314` (`if (isWorkerMode)`) constructs `ClaudeCliWorker`; `packages/orchestrator/src/server.ts:508` (`if (!isWorkerMode && ...)`) constructs `PrFeedbackMonitorService`. The two branches are mutually exclusive — worker and monitor never coexist in the same process. This makes constructor injection of a shared `Map` reference **infeasible** in worker mode (the reference would deserialize to a fresh empty map on the worker side).

The QueueItem is already the channel through which the monitor hands `prNumber` and `reviewThreadIds` to the handler (see `PrFeedbackMetadata` at `monitor.ts:38-43`). Adding one integer field costs nothing at the Redis / serialization layer and requires zero new infrastructure.

**Rejected alternatives** (both listed in FR-007 as "mechanism deferred to /plan"):
- **Constructor injection of shared `Map`** — would work only in a hypothetical single-process mode that does not exist in this codebase.
- **Shared reference** (e.g., module-level singleton) — same problem: cannot survive a Redis-mediated process boundary.
- **Have the handler compute its own counter from PR history** — would require reading past PR events / label transitions from GitHub, adding rate-budget cost per cycle. Contradicts Decision 2's rationale.

**Counter semantic**: `retryAttempt` = *number of auto-retries dispatched so far, including this dispatch*. Original cycle = `0`. First auto-retry = `1`. Second auto-retry = `2` (last). See `contracts/handler-counter-seam.md`.

## Decision 4 — Retry-budget model: counter-scoped, max 2, reset on full resolution (Q5=C)

**Chosen**: A small integer counter per `stateKey`, incremented on each retry-branch dispatch, capped at 2, reset **only** when all review threads on the PR are fully resolved (Case C branch at `pr-feedback-monitor-service.ts:296-317`).

**Rationale**: The SHA-keyed framing in the initial spec draft had a fatal edge case — a fixer that times out never reaches the no-diff branch (it exits through the timeout branch every cycle). Any cycle that writes one trivial commit advances the branch head SHA and refills a SHA-keyed budget → unbounded loop, 20 minutes per iteration, consuming a worker the whole time. Q5=A's "failsafe eventually terminates on no-diff" argument does not hold for exactly the population it applies to.

Q5=C is progress-aware without being SHA-fooled: the budget accumulates until the work actually completes (all threads resolved, which is what Disposition A eventually accomplishes when the review is small enough to fit in one window). If the work is genuinely too large for the budget, the operator gets a bounded terminal state (`blocked:fixer-timeout-repeat`) rather than an unbounded loop.

**Rejected**:
- **Q5=A** (reset on new SHA) — see rationale above; the failsafe is unreachable.
- **Q5=B** (retry-once, no counter) — defensible and simple but cuts off a legitimately large review after two windows even when each cycle was making real headway. Q5=C's counter with `max=2` still terminates that scenario cleanly (three windows) while being progress-aware.

**Sources**: clarifications.md §Q5 (full rationale, including the failsafe-unreachability argument).

## Decision 5 — Three-label vocabulary, not collapsed (Q3=C)

**Chosen**: Three distinct labels — `blocked:fixer-timeout` (retry-eligible), `blocked:fixer-timeout-no-progress` (terminal, zero commits), `blocked:fixer-timeout-repeat` (terminal, budget exhausted).

**Rationale**: Q3=A ("collapse zero-commit-timeout into `blocked:stuck-feedback-loop`") **re-introduces this issue's exact bug** — the whole #1070 complaint is that the label named the wrong cause and sent an operator hunting for a loop that did not exist. Choosing `blocked:stuck-feedback-loop` for a zero-commit *timeout* would repeat that mislabelling for a narrower case.

Q3=B ("single `blocked:fixer-timeout` label whose meaning depends on invisible state") violates the operator-triage principle: a label whose semantics vary with hidden state cannot be triaged from the label alone — an operator would need to grep worker logs to know whether a retry is coming.

Q3=C's three labels each carry a **single, stable meaning** an operator can act on without consulting the log:
- `blocked:fixer-timeout` → "a retry is coming; wait one cycle before intervening."
- `blocked:fixer-timeout-no-progress` → "no commits were pushed; retries would not help; intervene manually."
- `blocked:fixer-timeout-repeat` → "the fixer tried three times without finishing; intervene manually."

**Documented fallback** (from Q3 answer): if three timeout-family labels is judged too much vocabulary in code review, reuse `blocked:fixer-timeout-repeat` for the zero-commit case (both mean "timed out, no auto-retry, a human is needed"). Q3=A is not an acceptable simplification.

**Sources**: clarifications.md §Q3.

## Decision 6 — Keep `waiting-for:address-pr-feedback` across the retry chain (Q4=A)

**Chosen**: On the new `blocked:fixer-timeout` branch (and on both terminal branches — for symmetry with today's Disposition B behavior), `waiting-for:address-pr-feedback` is **kept in place**. The monitor's retry-branch re-add via `client.addLabels(...)` at `pr-feedback-monitor-service.ts:402` becomes a no-op.

**Rationale — load-bearing**: **Any window in which `waiting-for:*` / `agent:*` is absent is a window in which an incoming review is silently dropped.** This exact failure mode was hit in the field this session — PR reviews were discarded on a PR whose issue lacked an `agent:*` label, with no error anywhere. Q4=B (clear on timeout, re-add on retry tick) deliberately opens such a gap between the timeout and the retry tick and buys nothing for it; the "fresh cycle" framing is cosmetic.

**Rejected**:
- **Q4=B** (clear and let the monitor re-add on retry tick) — opens the silent-drop window described above.
- **Q4=C** (clear and DO NOT re-add on retry) — requires the monitor to special-case the retry-branch dispatch. More code for less clarity, still doesn't close the window fully.

**Sources**: clarifications.md §Q4.

## Decision 7 — Cockpit `WAITING_PIPELINE_ORDER` addition (/plan-time — Assumption 6 verification)

**Chosen**: Add the two **terminal** labels to `packages/cockpit/src/state/precedence.ts::WAITING_PIPELINE_ORDER` ahead of `waiting-for:address-pr-feedback`. Add `blocked:fixer-timeout` (retry-eligible) below `waiting-for:address-pr-feedback`. See plan.md §D-3 for the exact insertion.

**Rationale**: Spec §Assumption 6 stated "cockpit's existing 'any `blocked:*` outranks address-pr-feedback' logic already handles them correctly by prefix. (Verify at /plan.)" Verification found this half-true:

- Tier classification IS prefix-based (`label-map.ts:44-48`) — new labels correctly land in the `waiting` tier without any code change.
- Intra-tier precedence is NOT prefix-based (`precedence.ts:26-40`) — only exact-name matches in `WAITING_PIPELINE_ORDER` outrank other `waiting-for:*` gates. The three new labels sort **after** all listed gates by default (`precedence.ts:88-90`), which for the two terminal labels means cockpit surfaces `waiting-for:address-pr-feedback` and hides the terminal state — degraded relative to `blocked:stuck-feedback-loop`.

Rejected the "no cockpit change" reading of Assumption 6 on operator-triage grounds: an operator with only cockpit visibility should be able to see when a PR-feedback cycle has genuinely halted. The change is 3 array-literal lines.

**Sources**: `packages/cockpit/src/state/label-map.ts:44-48`, `packages/cockpit/src/state/precedence.ts:26-40, 85-95`.

## Implementation Patterns Referenced

- **Sibling `Map<string, X>` pattern**: `PrFeedbackMonitorService.lastUnresolvedThreadCount` at `pr-feedback-monitor-service.ts:79`. Same key shape (`${owner}/${repo}#${prNumber}`), same `Map.set` / `Map.get` / `Map.delete` idioms.
- **Sibling short-circuit ordering**: The existing `blocked:*` skip check at `pr-feedback-monitor-service.ts:373-389` is the point of insertion for the new retry-eligible branch (Decision 3 / D-4 in plan.md).
- **Sibling label-application helper**: `addBlockedStuckFeedbackLoopLabel` at `pr-feedback-handler.ts:1035-1056`. New helpers (`addBlockedFixerTimeoutLabel`, `addBlockedFixerTimeoutNoProgressLabel`, `addBlockedFixerTimeoutRepeatLabel`) follow the same shape: `try { addLabels } catch { warn }`.
- **Cockpit test shape**: `packages/cockpit/src/__tests__/e2e-address-pr-feedback.test.ts:119` — timeline-based simulation that this PR must not break (SC-005).

## Sources

- Bug report: [generacy#1070](https://github.com/generacy-ai/generacy/issues/1070).
- Field incident: generacy#1060 / PR #1065 (partial commit `79cb7888`, 20 files, six review findings addressed; only reply/resolve bookkeeping missed).
- Clarifications: [clarifications.md](./clarifications.md) — Q1-Q5.
- Related architecture: CLAUDE.md § "PR-feedback fixer consumes review bodies (#1047, planning phase)" — describes the marker-comment pattern that is the Q1=B fallback.
