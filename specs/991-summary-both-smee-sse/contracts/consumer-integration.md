# Contract: Consumer integration with `@generacy-ai/smee-backoff`

**Issue**: [#991](https://github.com/generacy-ai/generacy/issues/991)

## In scope

- `packages/orchestrator/src/services/smee-receiver.ts` (`SmeeWebhookReceiver`)
- `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts` (`SmeeDoorbellSource`)

## Public API stability

Both consumers must preserve their existing public API exactly. No option added, no option removed, no option renamed. Specifically:

- `SmeeReceiverOptions` — unchanged.
- `SmeeDoorbellSourceOptions` — unchanged.
- Exported symbol list from `smee-source.ts` — same modulo the removal of `MAX_BACKOFF_MS` (see "SC-003 grep sweep" below).

## Reconnect-loop contract (both consumers)

For every reconnect attempt, the sleep between attempts is exactly:

```ts
calculateBackoffDelay(this.reconnectAttempt, {
  base: this.baseReconnectDelayMs,
  cap: 30_000,
})
```

- `this.baseReconnectDelayMs` continues to come from the ctor option (default `5000` for the receiver, `5_000` for the doorbell).
- `cap` is the literal `30_000`. Not a class constant, not exported — the number lives at the call site to signal "this is the algorithm's cap, not this consumer's cap." (This diverges from the receiver's current style, which held it as a `private static readonly`. Rationale: after the extraction, the only remaining reference in each consumer *is* the call site, so a named class-level constant would just be indirection.)

## `reconnectAttempt` reset invariant (FR-008)

Both consumers must continue to reset `this.reconnectAttempt = 0` on successful SSE connect. This behaviour is not changing; the contract is captured here so the fake-timer test in `smee-source-reconnect.test.ts` has an explicit invariant to assert against.

## SC-003 grep sweep

After implementation, both must hold:

```bash
rg 'MAX_BACKOFF_MS' packages/orchestrator/src packages/generacy/src
# → zero hits
```

and

```bash
rg 'Math\.pow\(2, [^)]*attempt' packages/orchestrator/src packages/generacy/src
# → zero hits
```

Any surviving hit is a regression per FR-005.

## Import shape

Orchestrator:
```ts
import { calculateBackoffDelay } from '@generacy-ai/smee-backoff';
```

Generacy CLI:
```ts
import { calculateBackoffDelay } from '@generacy-ai/smee-backoff';
```

Identical import; no barrel re-export from either consumer.

## Fake-timer loop test contract (FR-007b)

**Location**: `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/smee-source-reconnect.test.ts` (new file).

**Setup**:
- `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`.
- Mock `fetch`: first N calls reject / return non-2xx to drive `reconnectAttempt` up to the cap; subsequent calls return a successful SSE stream.
- Construct `SmeeDoorbellSource` with the mock `fetch` and a minimal `gh` stub.

**Assertions**:
- After N failed attempts, `reconnectAttempt === expected-cap-attempt` (indirect — driven by observed sleep durations).
- On the (N+1)th `fetch` call succeeding, the elapsed fake-time between the failure and the next connection attempt is `< 30_000 + epsilon`.
- After successful connect, on a subsequent failure the elapsed time is back in the `[base/2, base)` band — i.e., `reconnectAttempt` reset to 0 (FR-008).

**Non-assertions** (to keep the test decoupled from internal loop shape):
- No assertion on private method call counts.
- No assertion on log lines.
- No assertion on internal `reconnectAttempt` field directly — always inferred from sleep-duration observables.

## Changeset

Single `.changeset/991-smee-backoff.md`:

```md
---
"@generacy-ai/smee-backoff": minor
"@generacy-ai/orchestrator": minor
"@generacy-ai/generacy": minor
---

Cap smee.io SSE reconnect backoff at 30s (was 5min) and add equal jitter, sharing
the algorithm via a new `@generacy-ai/smee-backoff` package. Reduces real-time
recovery latency for the orchestrator webhook receiver and the cockpit doorbell
after a transient smee.io outage.
```
