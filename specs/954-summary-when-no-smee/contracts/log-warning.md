# Contract: Smee-fallback warning log line

Normative payload for the Pino `warn` emitted when the cluster is genuinely webhook-less — no `config.smee.channelUrl`, no persisted channel file, and provisioning failed — so polling is the only feeder.

> **Adapted for the #952 resolver model.** #952 (merged to develop before this
> feature landed) made "no smee" an *async* determination: when
> `config.smee.channelUrl` is unset the orchestrator runs `SmeeChannelResolver`
> on `onReady`, which reads a persisted channel and, failing that, provisions a
> fresh smee channel. Webhook-less/polling is therefore only known once the
> resolver returns `null`. Emitting this warn at construction time (whenever
> `channelUrl` was unset) would fire even when a channel is about to be
> resolved/provisioned — a false "polling fallback" claim. The warn is emitted
> from the resolver's `null` branch instead.

## Emit site

`packages/orchestrator/src/server.ts`, inside the `onReady` resolver callback, on the webhook-less (`result === null`) branch:

```ts
if (!isWorkerMode && config.labelMonitor && config.repositories.length > 0) {
  // … labelMonitorService + startSmeePipeline …
  if (config.smee.channelUrl) {
    startSmeePipeline(config.smee.channelUrl);
  } else {
    server.addHook('onReady', async () => {
      // … guard + new SmeeChannelResolver(…) …
      const result = await resolver.resolve();
      if (result) {
        startSmeePipeline(result.channelUrl);
      } else {
        // ── warn here (cluster is webhook-less) ──
      }
    });
  }
}
```

Not as an `else` on the outer block (see clarifications Q3 → C rationale).

## Signature

```ts
server.log.warn(
  {
    pollIntervalMs: number,
    completedCheckInterval: number,
    processLatencyMs: number,
    completedLatencyMs: number,
    remediation: readonly string[],
  },
  'No smee channel configured; polling fallback active',
);
```

## Field contract

| field                    | type              | source                                                                | invariant |
|--------------------------|-------------------|-----------------------------------------------------------------------|-----------|
| `pollIntervalMs`         | `number`          | `monitorConfig.pollIntervalMs` (i.e. `config.monitor.pollIntervalMs`) | > 0 |
| `completedCheckInterval` | `number`          | `LabelMonitorService.COMPLETED_CHECK_INTERVAL` (const `3`)            | > 0 |
| `processLatencyMs`       | `number`          | `pollIntervalMs`                                                      | `=== pollIntervalMs` |
| `completedLatencyMs`     | `number`          | `pollIntervalMs * completedCheckInterval`                             | `=== pollIntervalMs * completedCheckInterval` |
| `remediation`            | `readonly string[]` | literal `['SMEE_CHANNEL_URL', 'orchestrator.smeeChannelUrl']`       | length ≥ 2; contains both strings |
| `msg`                    | `string`          | literal                                                               | `=== 'No smee channel configured; polling fallback active'` |
| `level`                  | `'warn'`          | Pino default from `.warn(…)`                                          | |

## Test invariants (SC-004)

Substring assertions against the serialised JSON line:

- Contains `"smee"` (from `msg`).
- Contains `"polling"` (from `msg`).
- Contains `"SMEE_CHANNEL_URL"` (from `remediation`).
- Contains `"orchestrator.smeeChannelUrl"` (from `remediation`).
- Contains `"pollIntervalMs"`, `"completedCheckInterval"`, `"processLatencyMs"`, `"completedLatencyMs"` (field names).

Numeric invariants:

- `record.completedLatencyMs === record.pollIntervalMs * record.completedCheckInterval`.
- When the test sets `config.monitor.pollIntervalMs = 60000`, the record must have `pollIntervalMs: 60000`, `processLatencyMs: 60000`, `completedLatencyMs: 180000`. This is the "computed, not hardcoded" test.

## Fires exactly-once per full-mode startup

- From the `onReady` resolver callback, on the webhook-less (`result === null`) branch — the true "no smee" moment under the #952 model. Not on the static-`channelUrl` path, and not when the resolver yields a channel (resolved or provisioned).
- Not repeated per cycle (this is not a runtime health check; it is a startup declaration).
- Not in worker mode (the `onReady` guard re-checks `!isWorkerMode`, and worker mode never reaches the label-monitor block).
- Not when `config.repositories.length === 0` (block condition + `onReady` guard; pre-activation wizard clusters).
- Not when `config.labelMonitor === false` (block condition + `onReady` guard; deliberate opt-out).

## Not this contract

- The `info` line covering `webhookSetup.enabled === false` — see `contracts/health-response.md` §appendix and `data-model.md` §4.
- The existing `info` at `server.ts:496` (`'Smee webhook receiver configured'`) — unchanged.
