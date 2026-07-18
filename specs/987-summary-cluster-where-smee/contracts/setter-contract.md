# Contract: `setWebhooksConfigured(true, opts?)`

**Feature**: `987-summary-cluster-where-smee`
**Applies to**: `LabelMonitorService`, `PrFeedbackMonitorService`, `MergeConflictMonitorService`, `ClarificationAnswerMonitorService`

## Signature

```ts
setWebhooksConfigured(configured: true, opts?: SetWebhooksConfiguredOptions): void;

export interface SetWebhooksConfiguredOptions {
  basePollIntervalMs?: number;
}
```

The literal type `true` on `configured` is load-bearing: TypeScript rejects `false` at compile time. There is no runtime assertion (Q1=A precludes a `false` branch).

## Preconditions

- The monitor service must be constructed (constructor has returned).
- The monitor's polling loop may or may not be running. The setter is safe to call in both states.
- `opts.basePollIntervalMs`, if supplied, must be `> 0`. No validation is performed (caller controls).

## Postconditions

Let `S` denote `this.state` (`MonitorState`) and `O` denote `this.options`.

After `setWebhooksConfigured(true, opts?)`:

| Field | New value |
|---|---|
| `S.webhooksConfigured` | `true` |
| `S.basePollIntervalMs` | `opts.basePollIntervalMs ?? S.basePollIntervalMs` (unchanged if opts omitted) |
| `S.currentPollIntervalMs` | `opts.basePollIntervalMs ?? S.basePollIntervalMs` (aligned to base) |
| `S.webhookHealthy` | unchanged |
| `S.lastWebhookEvent` | unchanged |
| `S.isPolling` | unchanged |
| `O.adaptivePolling` | **unchanged** — do not touch |
| `O.pollIntervalMs` | unchanged |
| `O.repositories` | unchanged |
| `O.maxConcurrentPolls` | unchanged |

## Idempotence

Calling `setWebhooksConfigured(true, opts)` twice with the same `opts` yields the same state as calling it once. The controller's decision function is pure over state; the second call is a no-op in terms of downstream behavior.

## Interaction with `decideAdaptivePoll`

After the setter runs:

- With no webhook events yet received (`S.lastWebhookEvent === null`):
  - `decideAdaptivePoll` returns `{ reason: 'quiet', transition: 'none', currentPollIntervalMs: S.currentPollIntervalMs, webhookHealthy: S.webhookHealthy }`.
  - `state.currentPollIntervalMs` stays at the smee `basePollIntervalMs` (no drop to fast interval).
- With events received and steady-state: `reason: 'quiet'`, no transition.
- With events received but stale by `> basePoll * 2`: `reason: 'webhook-stale'`, `transition: 'to-fast'`, `currentPollIntervalMs = computeFastInterval(basePoll, adaptiveDivisor, minPoll)`.
- On next event after staleness: `reason: 'webhook-recovered'`, `transition: 'to-base'`, `currentPollIntervalMs = basePoll`.
- Never returns `reason: 'webhooks-not-configured'` (that branch requires `S.webhooksConfigured === false`, which the setter has flipped).

## Non-behavior

- The setter does **not** call any I/O. No logs are emitted from within the setter. Callers may log around the invocation.
- The setter does **not** touch `S.webhookHealthy` (which is a `webhook has been delivering` signal, updated by `recordWebhookEvent()` and the controller). Setting it here would preempt the natural `lastWebhookEvent===null → quiet → first-event-arrives → healthy=true` transition.
- The setter does **not** clear `S.lastWebhookEvent`. If a receiver reconnects mid-run and re-invokes `startSmeePipeline` (this does not happen today, but is defensively allowed), preserving `lastWebhookEvent` keeps the staleness clock correct.

## Rejection cases

None. The setter accepts only `configured: true` (compile-time constraint). No exceptions are thrown.

## Test cases (informative)

Each of the four services' test suites should include:

1. **Flip flips flag**: construct with `webhooksConfigured=false`. Call `setWebhooksConfigured(true, { basePollIntervalMs: 600_000 })`. Assert `getState().webhooksConfigured === true`, `basePollIntervalMs === 600_000`, `currentPollIntervalMs === 600_000`.
2. **`adaptivePolling` untouched**: construct with `options.adaptivePolling=true`. Call the setter. Assert `options.adaptivePolling` is still `true` (spy on the private field via a getter, or verify via `decideAdaptivePoll` behavior post-flip).
3. **Staleness still reachable**: construct with `webhooksConfigured=false, adaptivePolling=true`. Call setter. Fire `recordWebhookEvent()` once (advance `lastWebhookEvent`). Fast-forward time > `basePoll * 2`. Trigger one poll cycle. Assert `updateAdaptivePolling` decision shape shows `reason: 'webhook-stale'`, `transition: 'to-fast'`, `currentPollIntervalMs === fast`.
4. **Recovery still reachable**: continue from case (3). Call `recordWebhookEvent()` again. Assert `reason: 'webhook-recovered'`, `transition: 'to-base'`, `currentPollIntervalMs === basePoll`.
5. **Idempotent double-flip**: call setter twice with same opts. State after 2nd call === state after 1st call.
6. **Type-level `false` rejection**: TypeScript build fails on `service.setWebhooksConfigured(false)`. Covered by a `@ts-expect-error` assertion in the test file.
