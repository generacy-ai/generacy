# Quickstart: Adaptive Polling for Smee-less Clusters

**Feature**: #953
**Branch**: `953-summary-updateadaptivepolling`

## What this changes

Before: monitor services with no configured webhook feeder returned early on every poll cycle — `updateAdaptivePolling()` never engaged, the interval never adapted, and the flag was dead code.

After: services with `webhooksConfigured === false` engage the fast interval on cycle 1 (when `adaptivePolling === true`) or stay at base (when `adaptivePolling === false`) — the flag is now a real reachable knob.

## Observing the fix

On a smee-less cluster (no `SMEE_CHANNEL_URL` env var) after this PR:

```
$ SMEE_CHANNEL_URL= pnpm --filter @generacy-ai/orchestrator dev
...
{"level":"info","intervalMs":10000,"reason":"webhooks-not-configured","msg":"Adaptive polling engaged — running at fast interval"}
```

Compare with the log line before the fix (nothing — service polled silently at 30s).

`getState()` on any monitor now includes `webhooksConfigured: boolean`:

```ts
{
  isPolling: true,
  webhookHealthy: false,             // meaningful only when webhooksConfigured=true
  webhooksConfigured: false,         // #953: new field
  lastWebhookEvent: null,
  currentPollIntervalMs: 10000,      // 30_000 / 3 clamped to MIN_POLL_INTERVAL_MS
  basePollIntervalMs: 30000
}
```

## Operator knobs

### LabelMonitor (smee-less)

| Config | Effect |
|---|---|
| `MONITOR_ADAPTIVE_POLLING=true` (default) | Fast: `basePollIntervalMs / 3` clamped to 10s — **10s at defaults**. |
| `MONITOR_ADAPTIVE_POLLING=false` | Base: `basePollIntervalMs` (30s default). Deliberate opt-out for tight rate-limit budgets. |

### PrFeedback (all clusters — feeder cannot be confirmed)

| Config | Effect |
|---|---|
| `PR_MONITOR_ADAPTIVE_POLLING=false` (**new default**) | Base: `basePollIntervalMs` (60s default). Matches previous observed cadence exactly. |
| `PR_MONITOR_ADAPTIVE_POLLING=true` | Fast: `basePollIntervalMs / 2` clamped to 10s — **30s at defaults**. |

### MergeConflict (all clusters — no feeder)

Shares `config.prMonitor` with PrFeedback. Same table as above.

## Breaking Changes

**None** in behavior for existing clusters. `PrMonitorConfigSchema.adaptivePolling.default` flips `true → false`, but the previous `true` value had no reachable effect — the twin services were sitting at their base cadence regardless. The flip preserves observed cadence and makes the flag reachable in both directions.

**Semantic change** in log output on smee-less LabelMonitor clusters: cycle 1 now emits a `to-fast` transition log line where the previous behavior emitted nothing. Downstream log-scraping alerts keyed on the current-mode absence-of-log may fire.

## Common Questions

**Q: Why doesn't PrFeedback derive `webhooksConfigured` from `PR_MONITOR_WEBHOOK_SECRET`?**

Because the secret controls signature verification, not whether GitHub can reach the endpoint. `routes/pr-webhooks.ts:11-14` accepts *every* payload unverified when no secret is set — the secret makes the route more restrictive, not more permissive. Presence of a secret is orthogonal to whether a feeder exists.

**Q: MergeConflict's `webhooksConfigured` is a hardcoded `false`. Why not wire a real derivation?**

Because `recordWebhookEvent()` at `merge-conflict-monitor-service.ts:332` has no callers anywhere. Adding a feeder is a separate feature — until one exists, any derivation would produce a value indistinguishable from the literal.

**Q: Why not just default `PR_MONITOR_ADAPTIVE_POLLING=true` and let operators opt out?**

Because that would silently double GitHub API load on every existing cluster the day the PR lands. `PrFeedback` and `MergeConflict` base cadences (60s) were tuned in a world where webhooks never arrive — that has always been their reality. Halving to 30s on the strength of a flag that has never had a reachable `true` behavior is not "compensating for a lost real-time path"; it is inventing new behavior.

## Verifying

Automated tests (from FR-007):

```bash
# Helper unit tests — the load-bearing regression
pnpm --filter @generacy-ai/orchestrator test adaptive-poll-controller

# Per-service integration through the helper
pnpm --filter @generacy-ai/orchestrator test label-monitor-adaptive
pnpm --filter @generacy-ai/orchestrator test pr-feedback-adaptive
pnpm --filter @generacy-ai/orchestrator test merge-conflict-adaptive
```

## Rollback

Revert this PR. All three services return to the dead-branch behavior (no adaptive polling engages on smee-less clusters), `PrMonitorConfigSchema.adaptivePolling` default returns to `true` (which continues to have no reachable effect — dead flag, same state as before this PR).

## Troubleshooting

**"My smee-less LabelMonitor is not polling every 10s"**
Check `MONITOR_ADAPTIVE_POLLING`. If `false`, the interval stays at `MONITOR_POLL_INTERVAL_MS` (30s default) — this is the intended opt-out. Also check whether smee *is* actually configured (`SMEE_CHANNEL_URL`); if so, LabelMonitor uses `SMEE_FALLBACK_POLL_INTERVAL_MS` (300s default), not the fast interval.

**"PrFeedback used to poll every 60s and now it's 30s"**
Someone has `PR_MONITOR_ADAPTIVE_POLLING=true` set. Unset it or set to `false`. The 30s cadence is the intentional opt-in behavior after this PR.

**"Adaptive polling engaged log is firing every cycle"**
Bug — the caller isn't writing `state.webhookHealthy = decision.webhookHealthy` after applying. Verify against the contract's Row 1 / Row 2 delta note.
