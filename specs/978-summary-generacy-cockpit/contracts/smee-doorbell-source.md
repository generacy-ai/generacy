# Contract: `SmeeDoorbellSource`

Slim SSE consumer for the smee.io channel. Filters payloads by the epic's
ref set and emits `CockpitStreamEvent`s to a caller-supplied sink.

## Signature

```ts
export class SmeeDoorbellSource {
  constructor(options: SmeeDoorbellSourceOptions);
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

`start()` returns once the SSE reader loop is running. It does NOT wait for
the first successful connect; the caller sees connect status via
`onReconnectSuccess` / `onReconnectAttempt`.

## Options

See `data-model.md` § SmeeDoorbellSourceOptions.

## Reconnect ladder

Exponential backoff matching
`packages/orchestrator/src/services/smee-receiver.ts`:

```
BASE_RECONNECT_DELAY_MS * 2^attempt, capped at 300_000 (5 min)
```

Progression: `5s → 10s → 20s → 40s → 80s → 160s → 300s (capped)`.

Counter resets to 0 on any successful connect.

## Ref-set refresh (Q2=D)

Three triggers:
1. On startup (blocking; the SSE loop does not start until `resolveEpic`
   completes successfully).
2. On any `issues` payload where `issue.number === refSet.epicNumber` AND
   `action ∈ {edited, labeled, unlabeled}`. Debounced 500 ms across bursts.
3. Safety-net `setInterval` every 10 min.

Refresh failures log a warning and preserve the previous ref-set (no
disruption to event emission).

## Event mapping

Delegates to `webhookToStreamEvent`. See
`contracts/webhook-to-event-mapping.md`.

## Aggregate emission

Delegates to `maybeRefreshAggregate`. See
`contracts/aggregate-on-demand.md`.

Both event types (issue-transition + aggregate) are emitted through the
same `onEvent` sink, in order:
1. First, the SSE-derived `CockpitEventValidated`.
2. Then, if aggregate refresh returned any events, one call per event.

## Error surfaces

| condition | behavior |
|---|---|
| SSE connect fails | `onReconnectAttempt(++failedAttempts)`; sleep backoff; retry. |
| SSE connects then errors mid-stream | Same as above. |
| SSE receives malformed JSON | Silently skip payload (matches SmeeWebhookReceiver). |
| `resolveEpic` fails at startup | Throws from `start()`. Doorbell's outer `runSmeeMode` catches and demotes to poll-mode via `SourceSelector`. |
| `resolveEpic` fails at refresh | Log warn; preserve previous `refSet`; continue. |
| `runOnePoll` fails during aggregate refresh | Log warn; skip aggregate emission for this trigger; continue. |
| `onEvent` sink rejects | Propagates — caller decides. Doorbell's sink is `stdout.write` which never rejects, so this is a test-only concern. |

## Shutdown

`stop()`:
1. Set `running = false`.
2. `abortController.abort()` on the SSE fetch.
3. Clear the safety-net timer and debounce timer.
4. Await any in-flight fetch to drain (bounded by `AbortSignal`).

Idempotent — repeat calls are no-ops.

## Test seams

- `fetch: typeof globalThis.fetch` — override to point at an in-process HTTP
  server.
- `now: () => number` — override to control backoff timing in tests.
- `runner?: CommandRunner` — passed to internal `GhCliWrapper` used for
  ref-set refresh (mock via existing runner-mocking patterns).
- `refreshDebounceMs`, `safetyNetIntervalMs`, `baseReconnectDelayMs` — all
  overridable for fast tests.
