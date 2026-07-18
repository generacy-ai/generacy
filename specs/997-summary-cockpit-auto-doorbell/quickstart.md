# Quickstart: Doorbell survives smee loss + quiet windows

**Issue**: [#997](https://github.com/generacy-ai/generacy/issues/997)
**Branch**: `997-summary-cockpit-auto-doorbell`

## What this feature does

Fixes three related failures in the `/cockpit:auto` wake sensor (`generacy cockpit doorbell`):

1. The doorbell no longer exits when its smee.io SSE connection drops. On any runtime demotion (failure count OR silence heuristic), it opens a **live poll bridge** — poll snapshots stream to stdout while `SmeeDoorbellSource.runLoop` keeps reconnecting smee in the background.
2. The 5-minute "no success" silence heuristic no longer false-positives on quiet-but-alive streams. `lastSuccessfulConnectAt` now refreshes on every inbound SSE byte (both event payloads AND smee.io's `:` keepalive comments), and the threshold shrinks to 90 s — 3× smee.io's ~30 s keepalive cadence. A 30–60-min quiet planning step is fine; a genuinely half-open TCP connection is detected within ~90 s.
3. The startup transient-fail path (discovery non-null but first connect never succeeded) now arms the `rePromoteTimer` so the doorbell can eventually recover to smee. Previously it fell into a dead-end poll state.

Behaviour after the fix, in one sentence: the doorbell keeps its stdout stream open indefinitely across smee.io outages, quiet windows, and any combination of the two.

## Install / build

Nothing to install operationally. Standard workflow:

```bash
pnpm install
pnpm --filter @generacy-ai/generacy build
```

## Running the doorbell

Same CLI as before — no new flags:

```bash
generacy cockpit doorbell <epic-ref>
generacy cockpit doorbell <tracking-ref> --tracking
generacy cockpit doorbell --new "<title>"
```

## Observing the source-mode transitions

The doorbell emits one stderr line per transition:

```
cockpit doorbell: source=smee reason=startup-smee-selected      # startup, smee happy path
cockpit doorbell: source=poll-fallback reason=startup-no-channel # startup, no channel discovered
cockpit doorbell: source=poll-fallback reason=startup-smee-failed # NEW — startup, smee attempt never connected
cockpit doorbell: source=poll-fallback reason=smee-runtime-lost  # runtime bridge open (failure count OR 90s silence)
cockpit doorbell: source=smee reason=smee-re-promoted            # bridge exit / rePromote timer recovered
```

**What changed**:

- `smee-runtime-lost` is now a bridge-open signal, not a process-exit signal. After it fires, the poll bridge is producing snapshots, and the smee source is still reconnecting in the background.
- `startup-smee-failed` is a new reason distinguishing "startup smee attempt never connected" from `smee-runtime-lost` (mid-run smee died).

## Testing

Run the selector unit tests:

```bash
pnpm --filter @generacy-ai/generacy test -- source-selector
```

Run the new bridge-mode regression tests (FR-007):

```bash
pnpm --filter @generacy-ai/generacy test -- doorbell-bridge
```

## Verifying the fix

### Manual: long, event-quiet run

Run a `/cockpit:auto` against an epic that will sit quiet for ≥60 minutes (e.g., a large implement-phase issue). The doorbell should:

- Emit `source=smee reason=startup-smee-selected` on startup.
- Emit zero further stderr transitions during the quiet window.
- Keep its stdout stream open — the parent `Monitor` sensor remains "running," not "completed."
- On any actual event (a label change, a PR update), one stdout line fires.

If you see `source=poll-fallback reason=smee-runtime-lost` during a quiet-but-alive stream, that's a regression against FR-002.

### Manual: transient smee.io drop

Kill your local smee.io channel mid-run (or wait for a natural blip). Expected:

1. Stderr: `source=poll-fallback reason=smee-runtime-lost` (after 5 consecutive reconnect failures — ~95 s with #991's backoff).
2. Stdout stream stays open. Poll snapshots begin flowing at ~30 s cadence.
3. Restore smee.io. `SmeeDoorbellSource` reconnects on its next attempt (bounded by #991's backoff).
4. Stderr: `source=smee reason=smee-re-promoted`. Poll bridge closes. Stdout keeps flowing.
5. The `Monitor` sensor was "running" the entire time.

If step 4 fails (bridge doesn't close on smee recovery), that's a regression against FR-004 / D4.

### Manual: sensor-alive verification

The simplest smoke test — run the doorbell, wait for any smee-loss condition, and check that the process is still alive:

```bash
generacy cockpit doorbell <epic-ref> &
DOORBELL_PID=$!
# ... wait 10 minutes, kill smee.io locally, wait 5 minutes ...
kill -0 $DOORBELL_PID && echo "alive" || echo "DEAD (regression)"
```

## Regression watchlist

If you're editing the doorbell in the future:

- **Never** call `s.source.stop()` from the `onModeChange('poll-fallback')` branch. That's the exact exit hole this fix closed.
- **Never** raise `DEFAULT_DEMOTE_AFTER_MS_WITHOUT_SUCCESS` to something scaled to step duration. The threshold is calibrated to smee.io's keepalive cadence, not to workload characteristics.
- **Never** remove the `onSseBytes` wiring in `runSmeeMode`. Without it, `lastSuccessfulConnectAt` regresses to refreshing only on reconnect — reintroducing the false-positive silence demotion.

## Troubleshooting

### "My quiet run just demoted after 90 s — why?"

Check that smee.io is actually sending keepalives. In the browser DevTools network panel, an SSE stream to `smee.io/<channel>` should show `:` comment frames roughly every 30 s. If those stop, that IS a dead-stream indicator and the 90 s demotion is doing its job (opening the poll bridge, not exiting).

### "The bridge opened but stdout stopped after ~30 s."

That would be a regression — the poll bridge is supposed to emit snapshots at ~30 s cadence. Check that `pollHandle` was actually assigned in the `onModeChange('poll-fallback')` branch and that `startPollMode()` returned `'ok'`. If it returned `'transient-fail'`, `stop()` was called (poll couldn't even start — a genuine dead end). That's not a #997 regression; it's a poll-side issue.

### "The `smee-re-promoted` line never fires after a smee.io recovery."

Two possibilities:

1. `SmeeDoorbellSource.runLoop` never called `onReconnectSuccess()` — check the fetch mock or the real HTTP response. `onReconnectSuccess` fires from `connect()` (line 304 in `smee-source.ts`) right after `response.ok` is confirmed.
2. `SourceSelector._current` was already `smee-active` when `onReconnectSuccess()` fired — meaning the bridge never opened in the first place. Check the earlier stderr for a missing `smee-runtime-lost` line.

### "Fake timers in `doorbell-bridge.test.ts` are flaky."

The tests use `vi.useFakeTimers()` with `vi.setSystemTime()` to drive both `Date.now()` and `setInterval` together. Flakiness usually means either the `elapsedTicker`'s 1 s interval isn't being advanced (check `vi.advanceTimersByTime`), or async microtasks between selector calls aren't flushed (check for `await` or `vi.runOnlyPendingTimersAsync()`).

## Next step

`/speckit:tasks` to generate the task list from this plan.
