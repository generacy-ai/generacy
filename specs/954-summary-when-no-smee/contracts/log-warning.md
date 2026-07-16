# Contract: Smee-fallback warning log line

Normative payload for the Pino `warn` emitted when `config.smee.channelUrl` is unset and the label monitor is being constructed.

## Emit site

`packages/orchestrator/src/server.ts`, immediately inside the block:

```ts
if (!isWorkerMode && config.labelMonitor && config.repositories.length > 0) {
  // … labelMonitorService construction …
  if (config.smee.channelUrl) {
    // existing receiver construction + info log
  } else {
    // ── NEW: warn here ──
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

- Not on `onReady` — at construction time.
- Not repeated per cycle (this is not a runtime health check; it is a startup declaration).
- Not in worker mode (block condition includes `!isWorkerMode`).
- Not when `config.repositories.length === 0` (block condition; pre-activation wizard clusters).
- Not when `config.labelMonitor === false` (block condition; deliberate opt-out).

## Not this contract

- The `info` line covering `webhookSetup.enabled === false` — see `contracts/health-response.md` §appendix and `data-model.md` §4.
- The existing `info` at `server.ts:496` (`'Smee webhook receiver configured'`) — unchanged.
