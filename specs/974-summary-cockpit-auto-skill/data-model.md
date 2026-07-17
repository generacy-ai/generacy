# Data Model — `generacy cockpit doorbell` verb

## Types introduced by this feature

### `DoorbellOptions` (in `doorbell.ts`)

```ts
interface DoorbellOptions {
  /** `--tracking` flag: positional is a tracking-issue ref, not an epic ref. */
  tracking?: boolean;
  /** `--new "<title>"` flag: no positional accepted; armed-only mode. */
  new?: string;
  /** `--exit-on-epic-complete` flag: exit 0 after emitting the epic-complete line. */
  exitOnEpicComplete?: boolean;
}
```

Populated by Commander from `--tracking`, `--new <title>`, `--exit-on-epic-complete`. All optional; Form dispatch in `runDoorbell` is by presence/absence.

### `DoorbellDeps` (in `doorbell.ts`, mirrors `WatchDeps`)

```ts
interface DoorbellDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
  rateLimitScheduler?: RateLimitScheduler;
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
  /**
   * Injection seam: replace `acquireEpicBus`. Tests use this to hand back a
   * pre-baked bus (`noPoll: true`) or a stubbed subscription with a controlled
   * `release` observer.
   */
  acquireBus?: (options: AcquireOptions) => Promise<Acquired>;
  /** Optional external abort — used by tests to stop the subscribe loop. */
  abortSignal?: AbortSignal;
  /** Test seam: stdout target for line writes. Defaults to `process.stdout`. */
  stdout?: { write(chunk: string, cb?: () => void): boolean | void };
  /** Test seam: exit hook. Defaults to `process.exit`. */
  exit?: (code: number) => never;
}
```

### `Form` (implementation-internal, not exported)

```ts
type Form =
  | { kind: 'form-1'; ref: string }
  | { kind: 'form-2'; ref: string }
  | { kind: 'form-3'; title: string };
```

Computed by a pure `classifyForm(positional: string | undefined, options: DoorbellOptions): Form | Rejection`. Rejection variants:

```ts
type Rejection =
  | { kind: 'missing-positional' }
  | { kind: 'conflicting-flags' };
```

The classifier is a private helper inside `doorbell.ts` and covered by unit tests.

### `SubscribeEmitOptions` (in `doorbell/subscribe.ts`)

```ts
interface SubscribeEmitOptions {
  stdout: { write(chunk: string, cb?: () => void): boolean | void };
  /**
   * Optional post-emit hook — called after each line's stdout drain. Used by
   * `runDoorbell` to detect `epic-complete` for FR-011.
   */
  onEmit?: (event: CockpitStreamEvent) => void;
}

type SubscribeUnsubscribe = () => void;

function subscribeAndEmit(
  bus: EpicEventBus,
  options: SubscribeEmitOptions,
): SubscribeUnsubscribe;
```

### `LineForEvent` (in `doorbell/subscribe.ts`)

Pure translator `event → string`:

```ts
function lineForEvent(event: CockpitStreamEvent): string {
  return `${event.type}\n`;
}
```

Isolated so the FR-005 / Q3=B contract lives in one testable function. Never called for the FR-010 `armed\n` line — that goes direct.

## Types reused from existing code

### `EpicEventBus` (from `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts`)

Existing broadcaster. The doorbell subscribes as one more listener; no changes to `EpicEventBus`.

**Emit contract we depend on**:
- `bus.emit(event: CockpitStreamEvent): EventBusEntry` synchronously appends to the buffer and flushes any pending waiters.
- No public `bus.on('event', …)` today — the doorbell must poll via `bus.waitFor({ sinceCursor, maxWaitMs, coalesceWindowMs, maxBatchSize })` in a loop, using the same waiter protocol `cockpit_await_events` uses.
- Each poll returns 0..N entries; the doorbell writes one stdout line per entry.

### `AcquireOptions` / `Acquired` (from `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts`)

Existing surface consumed as-is:

```ts
interface AcquireOptions {
  epicRef: string;
  runner?: CommandRunner;
  gh?: GhWrapper;
  intervalMs?: number;
  rateLimitScheduler?: RateLimitScheduler;
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
  noPoll?: boolean;
  now?: () => number;
  idleTtlMs?: number;
  maxBuses?: number;
  runCycle?: (bus: EpicEventBus) => Promise<void>;
}

interface Acquired {
  bus: EpicEventBus;
  release: () => void;
}
```

The doorbell passes `{ epicRef: <positional>, runner, gh, rateLimitScheduler, logger }` under Form 1/2. Under Form 3 it does NOT call `acquireEpicBus` at all.

### `CockpitStreamEvent` (from `packages/generacy/src/cli/commands/cockpit/watch/stream-event.ts`)

Discriminated union — the entire type-word contract lives here:

```ts
type CockpitStreamEvent =
  | { type: 'issue-transition'; /* … */ }
  | { type: 'phase-complete'; /* … */ }
  | { type: 'epic-complete'; /* … */ };
```

The three literal `type` strings are the only strings the doorbell writes to stdout (per FR-005 / Q3=B). If the union grows, `lineForEvent` is the one place to revisit — spec Assumptions §4 acknowledges this.

### `ResolvedIssueContext` (from `packages/generacy/src/cli/commands/cockpit/resolver.ts`)

Only relevant transitively — `acquireEpicBus`'s `expandRef` calls `resolveIssueContext`. The doorbell does NOT depend directly.

## Validation rules

1. **Positional presence** (FR-002):
   - Form 1/2 require a non-empty positional. Missing → exit 2 with `cockpit doorbell: parse issue: issue argument is required`.
   - Form 3 forbids a positional. Present → exit 2 with `cockpit doorbell: --new does not accept a positional argument`.

2. **Flag exclusivity** (FR-003):
   - `--tracking` and `--new` are mutually exclusive. Both → exit 2 with `cockpit doorbell: --tracking and --new are mutually exclusive`.

3. **Ref grammar** (FR-002, delegated via `acquireEpicBus` → `resolveIssueContext`):
   - Any grammar `resolveIssueContext` accepts. Bare numbers require a cwd git-origin (per #822 / #850) — the doorbell inherits that behavior for free.

4. **Line content** (FR-005 / Q3=B):
   - Each stdout line is exactly one of `issue-transition\n`, `phase-complete\n`, `epic-complete\n`, or (out-of-band) `armed\n`. Nothing else.

5. **Flush contract** (FR-006):
   - Every stdout write is drained before the next line's poll. Implementation via write-with-callback (see plan.md §Stdout contract, research.md §6).

6. **Exit codes**:
   - 0 — normal termination (SIGTERM/SIGINT, or FR-011 opt-in `epic-complete` exit).
   - 1 — unrecoverable poll/resolve failure surfaced through `acquireEpicBus` (rare; existing pattern from `watch.ts:129`).
   - 2 — argv validation errors (missing/rejected positional; conflicting flags). Matches `watch.ts:95, 105`.

## Relationships

```
   +--------------+           +---------------------+
   | doorbell.ts  |-- calls ->| acquireEpicBus()    |
   +--------------+           +----------+----------+
        |                                |
        | passes bus + stdout            | owns
        v                                v
   +--------------+           +---------------------+
   | subscribe.ts |<--emits---| EpicEventBus        |
   +--------------+           +---------------------+
        |
        | one process.stdout.write per event
        v
   +--------------+
   | process.stdout|
   +--------------+
```

The doorbell process's `event-bus-registry.ts` module-scoped `Map` is populated on `acquireEpicBus` and drained on `release()` → idle-TTL → LRU eviction. All in-process, no cross-process sharing (Q1=C).
