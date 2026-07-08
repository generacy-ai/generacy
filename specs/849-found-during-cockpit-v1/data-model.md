# Data Model: Pause-paired resume-dedupe clear

**Feature**: `849-found-during-cockpit-v1`
**Related**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [contracts/clear-resume-dedupe-callback.md](./contracts/clear-resume-dedupe-callback.md), [contracts/on-gate-hit-pairing.md](./contracts/on-gate-hit-pairing.md)

No new entities. No persisted state changes. This document catalogs the type-level changes plus the (existing, unchanged) Redis key schema for reference.

## New types

### `ClearResumeDedupeCallback` — NEW type alias (exported)

**File**: `packages/orchestrator/src/worker/label-manager.ts`

```ts
/**
 * Best-effort DEL of the paired `resume:<gate>` dedupe key.
 *
 * Invoked by `LabelManager.onGateHit` **after** the pause labels are successfully
 * applied on GitHub. The `gate` argument is the gate suffix (e.g., `"implementation-review"`),
 * NOT the full `waiting-for:*` label and NOT the full Redis key — key layout is a
 * `PhaseTrackerService` concern encoded by the closure at the wiring site.
 *
 * Contract:
 * - Errors thrown by this callback are caught and swallowed at `warn` — pause labels
 *   are the source of truth; the TTL backstop absorbs a missed clear.
 * - `undefined` (absent) callback means paired-clear is skipped. Matches pre-fix behavior.
 * - Idempotent: called once per gate hit; DEL on a non-existent key is a no-op.
 */
export type ClearResumeDedupeCallback = (gate: string) => Promise<void>;
```

Validation: none required at type level. Runtime error handling is contract'd in [contracts/clear-resume-dedupe-callback.md](./contracts/clear-resume-dedupe-callback.md).

## Modified interfaces

### `LabelManager` constructor — MODIFIED

**File**: `packages/orchestrator/src/worker/label-manager.ts:15-22`

**Before**:
```ts
constructor(
  private readonly github: GitHubClient,
  private readonly owner: string,
  private readonly repo: string,
  private readonly issueNumber: number,
  private readonly logger: Logger,
) {}
```

**After**:
```ts
constructor(
  private readonly github: GitHubClient,
  private readonly owner: string,
  private readonly repo: string,
  private readonly issueNumber: number,
  private readonly logger: Logger,
  private readonly clearResumeDedupe?: ClearResumeDedupeCallback,
) {}
```

- New parameter is optional and last-position for source-compatible construction from `label-manager.test.ts:21` (`createLabelManager()`).
- `readonly` matches surrounding fields' immutability convention.

### `ClaudeCliWorkerDeps` — MODIFIED

**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts:107-114`

**Before**:
```ts
export interface ClaudeCliWorkerDeps {
  processFactory?: ProcessFactory;
  sseEmitter?: SSEEventEmitter;
  jobEventEmitter?: JobEventEmitter;
  tokenProvider?: () => Promise<string | undefined>;
}
```

**After**:
```ts
export interface ClaudeCliWorkerDeps {
  processFactory?: ProcessFactory;
  sseEmitter?: SSEEventEmitter;
  jobEventEmitter?: JobEventEmitter;
  tokenProvider?: () => Promise<string | undefined>;
  /**
   * Redis-backed phase tracker used by `LabelManager` to invalidate the paired
   * `resume:<gate>` dedupe key at pause time. Absent → paired-clear is skipped.
   */
  phaseTracker?: PhaseTracker;
}
```

`PhaseTracker` imported from `../types/monitor.js` (same import path used by `label-monitor-service.ts`).

## Unchanged interfaces (referenced)

### `PhaseTracker` — UNCHANGED

**File**: `packages/orchestrator/src/types/monitor.ts:241-251`

```ts
export interface PhaseTracker {
  isDuplicate(owner: string, repo: string, issue: number, phase: string): Promise<boolean>;
  markProcessed(owner: string, repo: string, issue: number, phase: string): Promise<void>;
  clear(owner: string, repo: string, issue: number, phase: string): Promise<void>;
  tryMarkProcessed(owner: string, repo: string, issue: number, phase: string): Promise<boolean>;
}
```

The paired-clear invokes `clear()`. No new method needed; no signature change.

### `PhaseTrackerService.clear()` — UNCHANGED

**File**: `packages/orchestrator/src/services/phase-tracker-service.ts:63-79`

```ts
async clear(owner: string, repo: string, issue: number, phase: string): Promise<void> {
  if (!this.redis) return;
  const key = this.buildKey(owner, repo, issue, phase);
  try {
    await this.redis.del(key);
    this.logger.info({ key }, 'Cleared dedup key');
  } catch (error) {
    this.logger.warn({ err: error, key }, 'Redis error in clear, deduplication may block this event');
  }
}
```

Key contracts the fix depends on:
- Never throws (internal try/catch swallows all errors).
- No-op when `this.redis === null` (Redis unavailable path).
- `DEL` on a non-existent key returns `0`; the info log fires unconditionally on non-error paths.

## Redis key schema (unchanged)

**Layout** (`PhaseTrackerService.buildKey()` at `phase-tracker-service.ts:36`):
```
phase-tracker:<owner>:<repo>:<issue>:<phase>
```

For **resume** events, `<phase>` is `resume:<gate>`. Example for the FR-007 scenario:
```
phase-tracker:christrudelpw:sniplink:2:resume:implementation-review
```

**TTL**: default 86400s (24h). Configurable via `PhaseTrackerOptions.ttlSeconds`. Unchanged by this fix.

**Written by**: `PhaseTrackerService.markProcessed()` at `label-monitor-service.ts:339`, once per resume enqueue.
**Read by**: `PhaseTrackerService.isDuplicate()` at `label-monitor-service.ts:282`, once per resume label detection.
**Cleared by (before fix)**:
- `PhaseTrackerService.clear()` at `label-monitor-service.ts:279` — only for `type === 'process'` events. Resume events are not cleared.
- TTL expiry (24h).

**Cleared by (after fix)**:
- Same as above, PLUS:
- `PhaseTrackerService.clear()` invoked via `ClearResumeDedupeCallback` from `LabelManager.onGateHit` — every time a `waiting-for:<gate>` label is successfully applied. The `<phase>` argument passed by the wiring closure is exactly `resume:<gate>`, matching the key layout above.

## Relationships

```
LabelManager.onGateHit(phase, gateLabel="waiting-for:<gate>")
   │
   ├── retryWithBackoff(github.removeLabels + github.addLabels)   ← unchanged
   │       └── returns success  →  waiting-for:<gate> now on issue
   │
   ├── (this fix) if (this.clearResumeDedupe)
   │       ├── gateSuffix = gateLabel.slice("waiting-for:".length)
   │       ├── try { await this.clearResumeDedupe(gateSuffix) }
   │       │      catch { logger.warn(..., 'Failed to clear paired resume dedupe on pause') }
   │       └── logger.info(..., 'Cleared paired resume dedupe on pause')
   │
   └── returns

// At construction site (claude-cli-worker.ts:406):
new LabelManager(
  github, owner, repo, issueNumber, logger,
  this.phaseTracker
    ? (gate) => this.phaseTracker!.clear(owner, repo, issueNumber, `resume:${gate}`)
    : undefined,
)
```

The `resume:${gate}` string built in the closure is the exact `<phase>` argument that `label-monitor-service.ts:276` (`` const dedupPhase = type === 'process' ? parsedName : `resume:${parsedName}` ``) writes at enqueue time. Key layout parity guaranteed by:
- Same package boundary (`packages/orchestrator/src`)
- Same `phase-tracker:<owner>:<repo>:<issue>:<phase>` layout in `PhaseTrackerService.buildKey()`
- Same `resume:<gate>` string format on both sides

## Failure states (data-model level)

| State | Producer | Consumer effect | Notes |
|-------|----------|-----------------|-------|
| Key present with TTL, no fresh pause since write | `markProcessed` on prior resume | `isDuplicate → true`, resume dropped | **Bug before fix.** After fix: pause clears this state within one cycle. |
| Key absent | Never written, or `clear()` ran, or TTL expired | `isDuplicate → false`, resume enqueues | Normal state. |
| Key present, fresh pause + paired-clear failed | `markProcessed` on this cycle's earlier resume + swallowed DEL error | `isDuplicate → true` until TTL, then resume enqueues | Degraded: one paused issue re-strands for ≤24h. Operator runbook unchanged (`redis-cli DEL`). |
| Key present, fresh pause + paired-clear succeeded | `markProcessed` on this cycle's earlier resume + successful DEL | `isDuplicate → false`, resume enqueues | Fix's happy path. |
| Key absent, pause failed after retry | `addLabels` retries exhausted → onGateHit throws → DEL never runs | Neutral — no dedupe write for a pause that didn't happen | FR-009 asymmetric partial failure. |
| Key present, Redis unavailable at check time | `isDuplicate` catches Redis error, returns false | Resume enqueues (fail-open) | Existing behavior, unchanged. |
| No key, Redis unavailable at pause time | `clearResumeDedupe` closure calls `PhaseTracker.clear`, which no-ops when `this.redis === null` | Paired-clear silently skipped; no log because internal path returns before the info log | Consistent with `markProcessed` also being no-op in same conditions. |
