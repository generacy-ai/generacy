# Research: Adaptive Polling Engagement for Smee-less Clusters

**Feature**: #953
**Branch**: `953-summary-updateadaptivepolling`

## Decision Log

### D1: Shared helper vs. per-service copy fix (Q4 → C)

**Decision**: Extract `adaptive-poll-controller.ts` and migrate all three services.

**Rationale**: The bug exists *because* the block was copy-pasted three times. Fixing in place preserves the copy-paste hazard. `MergeConflictMonitorService.recordWebhookEvent()` has **no callers anywhere** — its adaptive polling is dead unconditionally, not just on smee-less clusters. `PrFeedbackMonitorService` is fed only by direct HTTP ingress (`pr-webhooks.ts:119`) that smee-based clusters don't use by construction, so its adaptive polling is also dead on the exact population #952 is designed to create.

**Alternatives**:
- Point-fix LabelMonitor only, follow-up issues for the twins. Rejected: leaves two known-bad paths live, one broken on every cluster.
- Point-fix in all three files. Rejected: same divergence pressure — divisor constants have already drifted (LabelMonitor `3`, twins `2`). Third round of copy-paste would compound the drift.

**Divisor divergence is intentional and preserved.** `pr-feedback-monitor-service.ts:40` documents "This differs from LabelMonitorService which uses `ADAPTIVE_DIVISOR = 3`" — the helper accepts divisor as a parameter, each caller passes its own.

### D2: Mechanism when `webhooksConfigured === false` (Q1 → A)

**Decision**: Fixed-fast interval from cycle 1. Compute `basePollIntervalMs / ADAPTIVE_DIVISOR` clamped to `MIN_POLL_INTERVAL_MS` at construction; `updateAdaptivePolling()` is a no-op on this branch after the initial emit.

**Rationale**: "Unhealthy" implies a condition that could recover; a cluster with no smee channel has no real-time path to recover *to*. B ("treat as unhealthy immediately") would emit `Webhooks appear unhealthy, increasing poll frequency` on every boot of every smee-less cluster — describing a transient degradation where the truth is a permanent structural fact. C ("seed `lastWebhookEvent` at loop start") spends `basePollIntervalMs * 2` rediscovering a construction-time constant.

### D3: State-model shape for the new signal (Q5 → A)

**Decision**: Add `webhooksConfigured: boolean` to `MonitorState` alongside existing `webhookHealthy`.

**Rationale**: Keeps `webhookHealthy` meaning "the configured webhook path is currently delivering" and adds a separate field for "a webhook path exists at all". Two genuinely different facts. Reusing `webhookHealthy` for both is the same overloading mistake that produced this bug (`lastWebhookEvent === null` conflated "no data yet" with "never configured"). Options-only reads (C) would split the test surface (`getState()` returns state; options aren't exposed).

### D4: Per-service `webhooksConfigured` derivation (Q6 → A, corrected)

**Decision**:
- LabelMonitor: `config.smee.channelUrl != null`
- PrFeedback: hardcoded `false`
- MergeConflict: hardcoded `false`

**Rationale**: LabelMonitor's derivation is well-founded because `webhookSetupService.ensureWebhooks` at `server.ts:824-826` actually **creates** the GitHub webhook against the smee channel — the same startup path that sets the flag also guarantees the feeder.

PrFeedback originally proposed to use `PR_MONITOR_WEBHOOK_SECRET != null` but the premise was inverted: reading `routes/pr-webhooks.ts:11-14` shows the secret makes the route *more* restrictive (auth), not more permissive. Presence of a secret is orthogonal to whether a feeder exists. Under the current codebase there is no signal available at construction to confirm a PrFeedback feeder — `false` is the honest value.

MergeConflict: `recordWebhookEvent()` at `merge-conflict-monitor-service.ts:332` has no callers. Not "dead on smee-less clusters" — dead unconditionally on every cluster in every configuration. `false` is the only truthful value.

**Alternatives**:
- Single derived `config.webhooks.configured` (B). Rejected: reads `true` for two services that provably lack a feeder on smee-only clusters.
- Anchor all three on smee (C). Rejected: MergeConflict has no feeder even on smee clusters, so `webhooksConfigured: true` would encode a known-false claim.

### D5: Default flip on `PrMonitorConfigSchema.adaptivePolling` (Q6 consequence)

**Decision**: Flip `adaptivePolling` default from `true` to `false` on `PrMonitorConfigSchema`. Operators opt in via `PR_MONITOR_ADAPTIVE_POLLING=true` (already wired at `config/loader.ts:194-200`).

**Rationale**: PrFeedback and MergeConflict base intervals (60s) were tuned in a world where webhooks never arrive — that has always been their reality. Halving to 30s under the "adaptive" flag is not "compensating for a lost real-time path"; it is silently re-tuning correct cadences on the strength of a flag that has never had a reachable `true` behavior. Preserves current cadence for every existing cluster while making the flag *reachable* in both directions — FR-005 satisfied more meaningfully than before (30s vs 60s is a real, choosable knob).

`MonitorConfigSchema.adaptivePolling.default(true)` stays — LabelMonitor's 30s base was tuned assuming smee, so compensating when smee is absent is coherent (restores an assumption the tuning depended on).

### D6: Operator opt-out semantics (Q3 → A)

**Decision**: `adaptivePolling: false` on a smee-less LabelMonitor cluster stays at `basePollIntervalMs` indefinitely.

**Rationale**: Natural reading of the flag. Protects operators on a tight GitHub rate-limit budget who deliberately want slower cadence. `fallbackPollIntervalMs` (300s) is a smee-configured concept — meaningless on smee-less clusters. Rejecting the combination (C) rejects a valid, useful configuration.

### D7: Grace period on cycle 1 (Q2 → A)

**Decision**: No grace. Fast interval used from the first poll after construction.

**Rationale**: The signal is a construction-time constant, so no initialization race to accommodate. Follows from Q1=A.

## Implementation Patterns

- **Helper interface**: returns a decision object (no `this`, no I/O). Caller owns state assignment + log emission — preserves per-service log strings and avoids mocking loggers in the helper's unit tests.
- **Change-detection log gating**: helper reports `transition` (`'to-fast' | 'to-base' | 'none'`) so callers log only on transitions, not every poll cycle. Matches existing pattern in `recordWebhookEvent()` (`if (wasUnhealthy) { ... log ... }`).
- **Clamp-vs-divide test separation**: at 30s base + divisor 3, `basePoll / DIVISOR == MIN_POLL_INTERVAL_MS`. Test cases MUST pick base+divisor combinations where the clamp does NOT bind, so failures reveal which computation went wrong.

## Key Sources

- `packages/orchestrator/src/services/label-monitor-service.ts:58-59, 116-120, 571-609` — divisor, min, state init, both methods
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:36-42, 99-105, 756-777` — same shape, divisor 2, base 60s
- `packages/orchestrator/src/services/merge-conflict-monitor-service.ts:27-34, 98-100, 332-360` — dead `recordWebhookEvent`, same shape
- `packages/orchestrator/src/services/smee-receiver.ts:57, 210` — smee is typed to LabelMonitor only, filters `x-github-event: issues`
- `packages/orchestrator/src/routes/pr-webhooks.ts:11-14, 119` — secret gates auth not existence; direct HTTP route always registered
- `packages/orchestrator/src/config/schema.ts:118-146` — MonitorConfigSchema, PrMonitorConfigSchema (default flip target)
- `packages/orchestrator/src/server.ts:464-529` — constructor callsite for all three services
- `packages/orchestrator/src/server.ts:824-826` — `webhookSetupService.ensureWebhooks` guarantees smee feeder
- `packages/orchestrator/src/types/monitor.ts:187-198` — MonitorState (add `webhooksConfigured`)
- `specs/953-summary-updateadaptivepolling/clarifications.md` — batches 1 & 2

## Related Issues

- #952 — Auto-provision smee when none configured. Related but orthogonal; #953 fixes the dead branch that must exist for any cluster that ever fails to provision.
- #869 — PrFeedback zero-trusted notice work (context for `ADAPTIVE_DIVISOR = 2` there).
- #898 — MergeConflictMonitorService origin (context for its no-caller `recordWebhookEvent`).
