# Contract: `adaptive-poll-controller.ts`

**Feature**: #953
**File**: `packages/orchestrator/src/services/adaptive-poll-controller.ts`
**Status**: New module — pure function, no I/O, no `this`.

## Purpose

Single decision function that every monitor service delegates to for adaptive-polling cadence choices. Extracted per Q4=C to eliminate the three-way copy-paste that produced the bug.

## Public Surface

### Types

```ts
export interface AdaptivePollParams {
  webhooksConfigured: boolean;
  adaptivePolling: boolean;
  basePollIntervalMs: number;
  currentPollIntervalMs: number;
  lastWebhookEvent: number | null;
  webhookHealthy: boolean;
  adaptiveDivisor: number;
  minPollIntervalMs: number;
  nowMs: number;
}

export type AdaptivePollReason =
  | 'webhooks-not-configured'
  | 'operator-opt-out'
  | 'webhook-stale'
  | 'webhook-recovered'
  | 'quiet';

export interface AdaptivePollDecision {
  currentPollIntervalMs: number;
  webhookHealthy: boolean;
  transition: 'to-fast' | 'to-base' | 'none';
  reason: AdaptivePollReason;
}
```

### Functions

```ts
/**
 * Decide the next poll cadence given current state and tuning.
 * Pure — no I/O, no time source captured internally (nowMs on params).
 *
 * Called from a monitor service's updateAdaptivePolling() to produce a
 * decision the caller applies to its state and logs on transitions.
 *
 * When webhooksConfigured=false AND adaptivePolling=true:
 *   Cycle 1  → { fast, healthy=false, transition='to-fast', reason='webhooks-not-configured' }
 *   Cycle 2+ → { fast, healthy=false, transition='none',   reason='webhooks-not-configured' }
 *
 * When webhooksConfigured=false AND adaptivePolling=false:
 *   Every    → { base, healthy=true,  transition='none', reason='operator-opt-out' }
 *
 * When webhooksConfigured=true AND lastWebhookEvent===null:
 *   Every    → { unchanged, healthy=unchanged, transition='none', reason='quiet' }
 *
 * When webhooksConfigured=true AND lastWebhookEvent!==null:
 *   staleness = nowMs - lastWebhookEvent
 *   threshold = basePollIntervalMs * 2
 *   if (staleness > threshold && webhookHealthy) → to-fast, reason='webhook-stale'
 *   else → { unchanged, healthy=unchanged, transition='none', reason='quiet' }
 *
 * `recordWebhookEvent` handler in each service also calls this to reset
 * cadence — that path maps to reason='webhook-recovered', transition='to-base'.
 */
export function decideAdaptivePoll(params: AdaptivePollParams): AdaptivePollDecision;

/**
 * Fast interval calculation used both by decideAdaptivePoll and directly by
 * services if they need the value at construction (rare — kept exported for
 * per-service tests that assert the clamp).
 */
export function computeFastInterval(
  basePollIntervalMs: number,
  adaptiveDivisor: number,
  minPollIntervalMs: number,
): number;
```

## Invariants

1. `decideAdaptivePoll` is a **pure function**. No `Date.now()` call inside; time flows in via `params.nowMs`.
2. `decision.currentPollIntervalMs >= params.minPollIntervalMs` on every branch.
3. `decision.currentPollIntervalMs <= params.basePollIntervalMs` on every branch.
4. `webhooksConfigured` is treated as immutable across calls — the function does not warn or gate on transitions of this field. Services set it once at construction.
5. `transition !== 'none'` implies the caller should emit a log line. `transition === 'none'` implies no log.
6. `reason` is stable per parameter shape — the same input reproduces the same reason. This lets tests assert on `reason` rather than on log strings.

## Test Matrix (referenced by FR-007)

| # | webhooksConfigured | adaptivePolling | lastWebhookEvent | webhookHealthy | staleness | Expected transition | Expected reason | Expected interval |
|---|---|---|---|---|---|---|---|---|
| 1 | false | true | null | true | — | `to-fast` | `webhooks-not-configured` | fast |
| 2 | false | true | null | false | — | `none` | `webhooks-not-configured` | fast (idempotent) |
| 3 | false | false | null | true | — | `none` | `operator-opt-out` | base |
| 4 | true | true | null | true | — | `none` | `quiet` | unchanged |
| 5 | true | true | 1000 | true | 3× base | `to-fast` | `webhook-stale` | fast |
| 6 | true | true | 1000 | false | 3× base | `none` | `quiet` | unchanged (already stale) |
| 7 | true | true | 1000 | true | 1× base | `none` | `quiet` | unchanged (within threshold) |

**Row 1 / Row 2 delta**: on the smee-less branch, `webhookHealthy` is the transition-edge cue. First call flips `false → decision.webhookHealthy: false`; second call sees `webhookHealthy === false` already and reports `'none'`. Caller must therefore write `state.webhookHealthy = decision.webhookHealthy` after applying — this is the mechanism by which the log line fires exactly once, not on every cycle.

**Recovery path** (row not in matrix — invoked from `recordWebhookEvent`, not `updateAdaptivePolling`):
- Precondition: `webhooksConfigured=true`, `webhookHealthy=false`, `currentPollIntervalMs=fast`
- Result: `to-base`, `webhook-recovered`, `currentPollIntervalMs=base`
- Callers invoke `decideAdaptivePoll` from within `recordWebhookEvent()` after updating `lastWebhookEvent = nowMs` and `webhookHealthy = true`.

## Clamp-vs-Divide Coverage

Test parameters MUST include a case where `basePollIntervalMs / adaptiveDivisor > minPollIntervalMs` (clamp does not bind) so the divide computation is verified. Recommended: `basePollIntervalMs=60_000, adaptiveDivisor=3, minPollIntervalMs=10_000 → fast=20_000`. Do not use `basePollIntervalMs=30_000, adaptiveDivisor=3, minPollIntervalMs=10_000` for the primary assertion — the clamp binds and hides a wrong divisor.

## Non-Goals

- Does not read env, config, or logger.
- Does not know service name or channel — callers own log strings.
- Does not persist state.
- Does not decide whether to run `recordWebhookEvent` (its counterpart is a caller concern; helper is invoked with the updated state).
