# Quickstart: smee SSE reconnect cap + jitter

**Issue**: [#991](https://github.com/generacy-ai/generacy/issues/991)
**Branch**: `991-summary-both-smee-sse`

## What this feature does

Lowers the smee.io SSE reconnect ceiling from **5 minutes** to **30 seconds** in both the orchestrator (`SmeeWebhookReceiver`) and the cockpit doorbell (`SmeeDoorbellSource`), and adds **equal jitter** so a fleet of clients on the same channel doesn't stampede a just-recovered endpoint.

Ladder before: `5s → 10s → 20s → 40s → 80s → 160s → 300s (cap)`.
Ladder after: `5s → 10s → 20s → 30s (cap)`, every step ±50% jittered.

## Install / build

Nothing to install operationally — this is an in-repo change to two existing packages plus one new leaf package. Standard workflow:

```bash
pnpm install
pnpm --filter @generacy-ai/smee-backoff build
pnpm --filter @generacy-ai/orchestrator build
pnpm --filter @generacy-ai/generacy build
```

## Using the helper from new code

```ts
import { calculateBackoffDelay } from '@generacy-ai/smee-backoff';

// Inside a reconnect loop:
const delayMs = calculateBackoffDelay(reconnectAttempt, {
  base: 5_000,
  cap: 30_000,
});
await sleep(delayMs, abortSignal);
```

Options:

- `base` (required) — the base pre-jitter delay in ms; the first attempt's un-capped value.
- `cap` (required) — hard ceiling. Output is bounded to `[cap/2, cap)`.
- `random` (optional) — inject a deterministic RNG for tests. Defaults to `Math.random`.

## Testing

Run the shared helper's unit tests:

```bash
pnpm --filter @generacy-ai/smee-backoff test
```

Run the doorbell fake-timer loop test (guards `reconnectAttempt` reset-on-success):

```bash
pnpm --filter @generacy-ai/generacy test -- smee-source-reconnect
```

## Verifying the fix locally

To eyeball the ladder without a live smee outage:

```ts
import { calculateBackoffDelay } from '@generacy-ai/smee-backoff';

for (let attempt = 0; attempt < 8; attempt++) {
  const min = calculateBackoffDelay(attempt, { base: 5_000, cap: 30_000, random: () => 0 });
  const max = calculateBackoffDelay(attempt, { base: 5_000, cap: 30_000, random: () => 0.9999 });
  console.log(`attempt=${attempt}  band=[${min}ms, ${max}ms]`);
}
```

Expected output:

```
attempt=0  band=[2500ms, ~5000ms]
attempt=1  band=[5000ms, ~10000ms]
attempt=2  band=[10000ms, ~20000ms]
attempt=3  band=[15000ms, ~30000ms]      # cap kicks in
attempt=4  band=[15000ms, ~30000ms]
attempt=5  band=[15000ms, ~30000ms]
attempt=6  band=[15000ms, ~30000ms]
attempt=7  band=[15000ms, ~30000ms]
```

## Regression watchlist

If you're editing either smee consumer in the future, keep the SC-003 grep sweep clean:

```bash
rg 'MAX_BACKOFF_MS' packages/orchestrator/src packages/generacy/src
# → must return zero hits
```

Any local re-declaration of `MAX_BACKOFF_MS` inside a consumer is a regression against FR-005.

## Troubleshooting

### "My reconnect is faster than 30 s after the cap — is that a bug?"

No — equal jitter can pull the observed delay down to `cap / 2 = 15 s`. The **cap** guarantees a ceiling, not a floor. The band is `[15 s, 30 s)` once the ladder saturates.

### "Attempt 0 is not exactly 5 s — is that a bug?"

No — per clarifications Q4 → A, jitter is applied at every attempt including `attempt=0`, so the observed delay at attempt 0 is in `[2.5 s, 5 s)`. This is intentional: it de-syncs a fleet when smee.io restarts and drops every client simultaneously. FR-006 was reinterpreted as "the pre-jitter base is 5 s".

### "My test is flaky because `Math.random` varies."

Inject `random`:

```ts
calculateBackoffDelay(attempt, { base: 5_000, cap: 30_000, random: () => 0.5 });
// → deterministic mid-band value
```

### "The receiver won't reconnect fast enough after a real smee.io outage."

Check that `reconnectAttempt` is actually resetting to 0 on successful connect (FR-008). Look for logs like `Connected to smee.io channel` — the next failure should sleep for `[2.5 s, 5 s)`, not for the cap. If it doesn't, the reset-on-success invariant broke; the doorbell fake-timer test should catch this before merge.

## Next step

`/speckit:tasks` to generate the task list from this plan.
