# Contract: `subscribeAndEmit(bus, options): unsubscribe`

Applies to `packages/generacy/src/cli/commands/cockpit/doorbell/subscribe.ts`.

## Signature

```ts
function subscribeAndEmit(
  bus: EpicEventBus,
  options: {
    stdout: { write(chunk: string, cb?: () => void): boolean | void };
    onEmit?: (event: CockpitStreamEvent) => void;
  },
): () => void;
```

## Behavior

- Drives an internal `bus.waitFor({ sinceCursor, maxWaitMs, coalesceWindowMs, maxBatchSize })` polling loop, starting at `sinceCursor: 0`.
- For each returned entry:
  1. Write `lineForEvent(entry.event)` to `options.stdout` with a completion callback.
  2. Await the drain callback (FR-006).
  3. Advance the internal cursor to `entry.cursor`.
  4. If `options.onEmit` was provided, call it with `entry.event` after the drain.
- On the returned `unsubscribe()`: aborts the internal loop and resolves in-flight `waitFor` cleanly. Idempotent — a second call is a no-op.

## `lineForEvent` — the type-word contract

```ts
lineForEvent({ type: 'issue-transition', … }) === 'issue-transition\n'
lineForEvent({ type: 'phase-complete', … })   === 'phase-complete\n'
lineForEvent({ type: 'epic-complete', … })    === 'epic-complete\n'
```

- No JSON.
- No ref.
- No trailing whitespace before the newline.
- Exactly one line per event.

## Invariants

1. **1:1** — for each `bus.emit()`, exactly one `options.stdout.write` call, exactly one line (SC-003 / FR-005).
2. **Ordered** — lines emit in the order `bus.emit` was called. Cursor monotonicity in `EpicEventBus` guarantees this.
3. **Drain-per-line** — the write callback fires before the next `waitFor` is issued. Callers can rely on stdout being flushed after each line (FR-006).
4. **No filter** — every `bus.emit()` produces a line. `epic-complete` is not special-cased inside `subscribeAndEmit`; `--exit-on-epic-complete` is enforced at the `doorbell.ts` level via `options.onEmit` (see `data-model.md §SubscribeEmitOptions`).
5. **No stderr writes** — subscribe never touches stderr; poll errors are surfaced by `event-bus-registry.ts`'s internal `logger.warn`.

## Test surface

`packages/generacy/src/cli/commands/cockpit/__tests__/doorbell.subscribe.test.ts` covers:
- Emit 3 events, assert 3 stdout writes, correct order, correct type-word content.
- Assert drain callback invoked for each write.
- `unsubscribe()` mid-loop: no further writes after the call resolves.
- `onEmit` hook fires once per event.

## Non-goals

- Not responsible for the FR-010 `armed\n` line — that is `doorbell.ts`'s job, direct to stdout.
- Not responsible for exit lifecycle — `doorbell.ts` owns signals + `--exit-on-epic-complete`.
- Not responsible for bus lifecycle — caller holds the `Acquired` handle from `acquireEpicBus`.
