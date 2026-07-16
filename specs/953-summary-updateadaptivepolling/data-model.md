# Data Model: Adaptive Polling State

**Feature**: #953
**Branch**: `953-summary-updateadaptivepolling`

## Entities

### `MonitorState` (modified)

**File**: `packages/orchestrator/src/types/monitor.ts:187-198`

Adds `webhooksConfigured: boolean` alongside existing fields. Zero-initialized in each service constructor from a new positional argument.

```ts
export interface MonitorState {
  /** Whether the polling loop is running */
  isPolling: boolean;

  /**
   * Whether the configured webhook path is currently delivering events.
   * Only meaningful when `webhooksConfigured === true`.
   * When `webhooksConfigured === false`, this field's value is not consulted.
   */
  webhookHealthy: boolean;

  /**
   * Timestamp of the last webhook event received.
   * Stays `null` on smee-less clusters (no receiver ever calls `recordWebhookEvent`).
   */
  lastWebhookEvent: number | null;

  /** Current effective poll interval (adaptive) */
  currentPollIntervalMs: number;

  /** Configured base poll interval */
  basePollIntervalMs: number;

  /**
   * #953: Whether a webhook feeder is configured for this service.
   * Set once at construction from a per-service derivation rule; never mutated.
   * Distinguishes "webhooks configured but quiet" (grace applies) from
   * "no webhook path exists at all" (skip adaptive-polling, engage fast interval).
   */
  webhooksConfigured: boolean;
}
```

**Validation**: `webhooksConfigured` is a boolean, no runtime validation needed beyond TypeScript. Sourced once at construction, immutable afterward.

**Derivation per service** (Q6=A corrected):
| Service | Value |
|---|---|
| LabelMonitorService | `config.smee.channelUrl != null` |
| PrFeedbackMonitorService | `false` (literal) |
| MergeConflictMonitorService | `false` (literal) |

### `AdaptivePollParams` (new)

**File**: `packages/orchestrator/src/services/adaptive-poll-controller.ts` (new)

Pure decision input. Callers pass the mutable state slice they need plus their tuning constants.

```ts
export interface AdaptivePollParams {
  /** From MonitorState — construction-time constant. */
  webhooksConfigured: boolean;

  /** From service options — reflects config knob. */
  adaptivePolling: boolean;

  /** From MonitorState — configured base cadence. */
  basePollIntervalMs: number;

  /** Current cadence being run at (for transition detection). */
  currentPollIntervalMs: number;

  /** From MonitorState — null when never received. */
  lastWebhookEvent: number | null;

  /** From MonitorState — current health belief. */
  webhookHealthy: boolean;

  /** Per-service tuning: LabelMonitor=3, PrFeedback=2, MergeConflict=2. */
  adaptiveDivisor: number;

  /** Per-service tuning: 10_000 across all three today. */
  minPollIntervalMs: number;

  /**
   * Injected for testability. Callers pass `Date.now`.
   * Only consulted on the `webhooksConfigured === true` branch.
   */
  nowMs: number;
}
```

### `AdaptivePollDecision` (new)

**File**: `packages/orchestrator/src/services/adaptive-poll-controller.ts` (new)

Pure decision output. Caller applies to `state` and emits its own log.

```ts
export type AdaptivePollReason =
  | 'webhooks-not-configured'   // structural — smee-less, adaptivePolling=true
  | 'operator-opt-out'          // structural — adaptivePolling=false
  | 'webhook-stale'             // observed — configured but quiet past threshold
  | 'webhook-recovered'         // observed — event arrived after stale
  | 'quiet';                    // observed — configured, within grace, no change

export interface AdaptivePollDecision {
  /** New effective cadence to run at. */
  currentPollIntervalMs: number;

  /** New health belief. Meaningful only when webhooksConfigured===true. */
  webhookHealthy: boolean;

  /**
   * Whether an edge fired this call. Caller uses this to gate log emission.
   * - 'to-fast': cadence dropped to the adaptive fast interval
   * - 'to-base': cadence returned to base (webhook recovered)
   * - 'none': no cadence change; may still update webhookHealthy
   */
  transition: 'to-fast' | 'to-base' | 'none';

  /** Why the decision was reached — used for log field. */
  reason: AdaptivePollReason;
}
```

## Relationships

```
LabelMonitorService  ─┐
PrFeedbackMonitorService  ─┼──► decideAdaptivePoll(params) : AdaptivePollDecision
MergeConflictMonitorService ─┘         (pure function, no I/O)

server.ts.createServer()
  └─► instantiates each service
       └─► passes webhooksConfigured (per-service derivation)
       └─► service constructor sets state.webhooksConfigured
```

## Invariants

- `MonitorState.webhooksConfigured` is set at construction and never mutated.
- `AdaptivePollDecision.currentPollIntervalMs >= minPollIntervalMs` for all decisions.
- When `webhooksConfigured === false && adaptivePolling === true`:
  - First call → `transition: 'to-fast'`, `reason: 'webhooks-not-configured'`
  - Subsequent calls → `transition: 'none'` (steady state)
- When `webhooksConfigured === false && adaptivePolling === false`:
  - Every call → `transition: 'none'`, `reason: 'operator-opt-out'`, `currentPollIntervalMs = basePollIntervalMs`
- When `webhooksConfigured === true && lastWebhookEvent === null`:
  - Every call → `transition: 'none'`, `reason: 'quiet'` (preserves existing grace)
- When `webhooksConfigured === true && lastWebhookEvent !== null`:
  - Reproduces the existing `updateAdaptivePolling()` logic (stale-detection + recovery on `recordWebhookEvent`).

## Config Schema Change

**File**: `packages/orchestrator/src/config/schema.ts:143`

```ts
// Before:
adaptivePolling: z.boolean().default(true),

// After:
adaptivePolling: z.boolean().default(false),  // #953: fixed dead branch would silently double GH API load
```

Applies to `PrMonitorConfigSchema` only. `MonitorConfigSchema.adaptivePolling.default(true)` unchanged — LabelMonitor's 30s base was tuned assuming a real-time path, and the fast interval on smee-less clusters restores that assumption.

`config/loader.ts:194-200` already maps `PR_MONITOR_ADAPTIVE_POLLING` env → `adaptivePolling`, so operator opt-in is already wired.
