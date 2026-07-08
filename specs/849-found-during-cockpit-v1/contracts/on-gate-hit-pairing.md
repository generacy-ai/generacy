# Contract: `LabelManager.onGateHit` — paired-lifecycle behavior

**Feature**: `849-found-during-cockpit-v1`
**Covers**: FR-002, FR-005, FR-007, FR-008, FR-009, FR-011, SC-001, SC-002

## Public signature (unchanged)

```ts
async onGateHit(phase: WorkflowPhase, gateLabel: string): Promise<void>
```

- `phase` — the current workflow phase (`'specify' | 'clarify' | 'plan' | 'tasks' | 'implement' | 'validate'`).
- `gateLabel` — full `waiting-for:<suffix>` label to apply.
- Returns after both labels are applied on GitHub (retry-guarded) and — if wired — the paired-clear callback has run.

## Semantic contract

`onGateHit` is the sole `waiting-for:*` label-apply path in the orchestrator (spec Assumption 2). Every invocation represents a *new pause* at `<suffix>`. The paired-lifecycle contract:

> **A new pause invalidates the prior cycle's `resume:<suffix>` dedupe.**

Implementation:

1. Apply `waiting-for:<gate>` + `agent:paused`, remove `phase:<phase>` + `completed:<phase>`. Wrapped in `retryWithBackoff` (3 attempts, 1s/2s/4s delays).
2. If step 1 returns success AND `clearResumeDedupe` was wired at construction: invoke `clearResumeDedupe(<suffix>)` exactly once, catch any error, log at `info` on success or `warn` on catch.
3. Return. If step 1 threw after retry exhaustion, that throw propagates and step 2 does not run.

## Ordering (FR-009 / Q1→A)

**Required order**:
```
retryWithBackoff( removeLabels + addLabels )   ← must complete successfully
  ↓
clearResumeDedupe(gateSuffix)                  ← runs only if above returned
```

**Forbidden orderings**:

- DEL before label-apply: introduces the failure mode `{ DEL succeeded, addLabels failed }` where dedupe is cleared for a pause that never manifested on GitHub. A stale `completed:<gate>` on the issue could enqueue a resume for a pause that doesn't exist. Rejected in [research.md](../research.md#decision-del-after-label-apply-success-q1a--fr-009).
- DEL inside `retryWithBackoff`: DEL failures would consume the retry budget and could cause the whole pause to throw over a Redis problem. FR-003 explicitly forbids blocking pause on Redis health.
- DEL on retry-exhaustion (in a `finally` block): same failure mode as DEL-before-label — the DEL runs regardless of whether the pause manifested.

## One-shot (FR-010)

- Callback is invoked **exactly once** per `onGateHit` call, after retry success.
- No caller-side retry loop.
- No inline mini-retry.
- Terminal DEL failure: log at `warn`, swallow, return.

## Scoping (FR-004, FR-005)

- Callback receives only the gate suffix. Wiring closure builds `resume:<suffix>` for this specific `(owner, repo, issue)` triple.
- Other dedupe keys (`process:*`, other gates' `resume:*`, other issues) are unreachable.
- `label-monitor-service.ts:273-282` (`process` clear before check) is unaffected — separate call site, separate lifecycle point.
- `label-monitor-service.ts:339` (`markProcessed` after enqueue) is unaffected — dedupe is still written per resume.

## Second-pause-in-cycle safety (FR-002)

`onGateHit` has no "have I seen this gate?" state. The paired-clear fires on **every** invocation, including:

- First pause at a gate in a fresh workflow.
- Second pause at the same gate after a resume→re-pause cycle within the same phase (e.g., `implementation-review` → request-changes → address feedback → back to `implementation-review`).
- Re-pause after webhook redelivery (idempotent — DEL on absent key is a no-op).

## Single-cycle dedupe preservation (FR-008 / SC-003)

Within a single pause→resume cycle:

1. `onGateHit` fires → paired-clear runs → key deleted.
2. Resume trigger 1 → `markProcessed` → key written with TTL.
3. Resume trigger 2 (duplicate: retry, webhook + poll race, double-click) → `isDuplicate → true` → dropped.
4. No further `onGateHit` fires until the next cycle → key persists → protection intact.

The fix does NOT weaken the single-cycle guarantee — the paired-clear runs at the *start* of a pause, not at the *check* of a resume.

## Observability (FR-011 / Q4→A)

On successful paired-clear:
```ts
logger.info(
  { phase, gateLabel, owner, repo, issueNumber },
  'Cleared paired resume dedupe on pause',
);
```

On swallowed DEL failure:
```ts
logger.warn(
  { phase, gateLabel, owner, repo, issueNumber, error: String(error) },
  'Failed to clear paired resume dedupe on pause (non-fatal, TTL backstop will absorb)',
);
```

- Message strings are stable — SC-002 measurement relies on log-grep matching them.
- Fields chosen to identify the specific `(owner, repo, issue, gate)` tuple operators use in the `redis-cli DEL phase-tracker:<owner>:<repo>:<issue>:resume:<gate>` runbook.
- `phase` field enables filtering by workflow phase (e.g., "how often does the paired-clear fire at `implement`?").
- `error: String(error)` matches the existing pattern in `LabelManager.ensureCleanup` (`label-manager.ts:219`).

## Failure envelope

| Failure at step | Behavior | Log | Side effect |
|-----------------|----------|-----|-------------|
| `retryWithBackoff(removeLabels)` — retries exhausted | Throws from `onGateHit` | `logger.error` from the retry helper (existing) | No labels applied, no paired-clear |
| `retryWithBackoff(addLabels)` — retries exhausted | Throws from `onGateHit` | `logger.error` from the retry helper (existing) | Partial label state possible (some removed but pause label not added); no paired-clear (FR-009 asymmetric partial failure) |
| Callback throws | Swallowed | `logger.warn(..., 'Failed to clear paired resume dedupe on pause ...')` | Pause labels applied, dedupe persists to TTL for this pause |
| Callback resolves | Continues | `logger.info(..., 'Cleared paired resume dedupe on pause')` | Pause labels applied, dedupe key deleted |
| No callback wired | Skipped | No log | Pre-fix behavior; pause labels applied, dedupe unchanged |

## Test surface

Regression tests (see [plan.md §Technical Context](../plan.md#technical-context)):

- **FR-002**: `label-manager.test.ts` — call `onGateHit` twice with the same `(phase, gateLabel)` in sequence. Assert the callback fires on both calls.
- **FR-007 / SC-001**: `pr-feedback-integration.test.ts` — full pause→resume→pause→resume through `implementation-review`. Assert `LabelMonitorService.processLabelEvent` on the second resume returns `true` (enqueued), not deduped.
- **FR-008 / SC-003**: `phase-tracker-service.test.ts` and `label-manager.test.ts` combined — within one cycle, second resume trigger IS deduped by `isDuplicate()`. Confirms single-cycle protection intact.
- **FR-009**: `label-manager.test.ts` — mock `github.addLabels` to throw on all retries; assert callback NOT called and `onGateHit` throws.
- **FR-011**: `label-manager.test.ts` — assert `logger.info` message + fields on happy path; assert `logger.warn` message + fields when callback rejects.
- **SC-002**: log-grep at deploy time — search for `'Cleared paired resume dedupe on pause'` in the orchestrator logs on the affected test project; assert zero `redis-cli DEL phase-tracker:` invocations across operator runbooks post-fix.
- **SC-004**: `label-manager.test.ts` — mock the callback to reject with a synthetic error; assert `github.addLabels` was still called (pause proceeds).
