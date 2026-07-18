# Research: Doorbell survives smee loss + quiet windows

**Issue**: [#997](https://github.com/generacy-ai/generacy/issues/997)
**Branch**: `997-summary-cockpit-auto-doorbell`

## Decision log

### D1. Byte-liveness home: `SmeeDoorbellSource` (not `SourceSelector`)

**Decision**: `SmeeDoorbellSource` owns the byte-arrival signal. It invokes a new optional `onSseBytes?: () => void` callback after every `reader.read()` that returns bytes, in `connect()`'s inner loop. `SourceSelector.onSseBytes()` is the public method that consumes it (refreshes `lastSuccessfulConnectAt` when in `smee-active`).

**Rationale** (from spec FR-002 note, Q1 → B):

- The connection owner is the only place with a byte stream to observe. Passing bytes up to the selector would require exposing a reader or forcing the selector to hold the fetch response.
- Callback shape mirrors the existing `onReconnectAttempt(failedAttempts: number)` / `onReconnectSuccess()` signals. Consistent surface; nothing new to learn for a code reader.
- Non-optional would break the existing tests that construct `SmeeDoorbellSource` without wiring the doorbell. Optional keeps existing call sites valid.

**Alternatives considered**:

- **`SourceSelector` polls a `bytesReceivedAt` field on `SmeeDoorbellSource`**. Rejected — makes the selector reach into another object's state; couples them tighter than a callback.
- **`SmeeDoorbellSource` emits an event on a Node `EventEmitter`**. Rejected — no other callback on the class uses that pattern; introducing one just here is inconsistent.
- **Refresh liveness only on event payloads, not keepalives (Q1 → C)**. Rejected in clarifications: a quiet-but-alive smee.io stream can go 30–60 min between real event payloads on quiet epics; refreshing only on payloads reproduces the exact false-positive we're eliminating.

### D2. Silence threshold value: `90_000` ms (down from `300_000` ms)

**Decision**: `DEFAULT_DEMOTE_AFTER_MS_WITHOUT_SUCCESS = 90_000`.

**Rationale** (from spec FR-002, clarifications Q1 → B "small multiple of the smee.io keepalive interval"):

- smee.io emits SSE `:` comment keepalives on healthy connections at a ~30 s cadence (documented behaviour of the `smee.io` client's SSE stream).
- 3× keepalive interval = 90 s. Miss one keepalive → still alive. Miss two → grace. Miss three → treat as dead.
- Small enough that a genuinely half-open TCP connection is detected within ~90 s (not the 5+ minutes of the old threshold).
- Large enough to tolerate a single lost keepalive without a false positive.

**Alternatives considered**:

- **`60_000` ms (2× keepalive)**. Sharper detection, but a single-lost-keepalive false-positive is more likely. FR-004's non-terminal bridge softens the blast radius, but tighter isn't obviously better.
- **`120_000` ms (4× keepalive)**. Safer against false positives, but 2 minutes of "the sensor is silently dead" is longer than needed.
- **Keep at `300_000` ms**. Rejected — the spec explicitly rules this out (Q1 → B "small multiple of the keepalive interval — NOT beyond step duration").

### D3. Runtime demotion mechanism: strictly non-terminal live bridge

**Decision** (from spec FR-004, Q2 → B): On `smee-active → poll-fallback` transition (from failure count OR silence heuristic), the smee source is **NOT** stopped. Its `runLoop` keeps reconnecting in the background. The poll bridge is started alongside. Both stdout and the smee reconnect loop stay alive.

**Rationale**:

- The core bug is that today's `onModeChange('poll-fallback')` branch (`doorbell.ts:483-497`) `await`s `s.source.stop()`, then starts poll-mode. After a successful poll-mode start, the eventual `stopPromise` resolution (from an external signal or an error path) ends the stdout stream. Removing the `s.source.stop()` call preserves the smee reconnect loop and closes the exit hole (Q2 → B, FR-001).
- The `SmeeDoorbellSource.runLoop` (`smee-source.ts:248-287`) already runs an unbounded reconnect loop with #991's bounded backoff. It doesn't need external nudging.
- Live poll bridge preserves ~30 s poll latency during a smee outage instead of dropping to the operator's 5-min heartbeat. The whole `/cockpit:auto` value proposition is real-time-ish.

**Alternatives considered**:

- **Remove runtime demotion entirely (Q2 → A)**. Rejected in clarifications: preserves ~30 s poll latency during a smee outage — better real-time behaviour than sitting silent on the still-reconnecting smee source.
- **Signal a warning but stay on smee (Q3 → C shape)**. Rejected — a warning alone leaves the run dark during a real outage.

### D4. Bridge-exit signal: `onReconnectSuccess()` while in `poll-fallback`

**Decision**: When `SmeeDoorbellSource` succeeds a reconnect (calls `onReconnectSuccess()`) AND the selector's `_current === 'poll-fallback'`, the selector transitions directly to `smee-active` with reason `smee-re-promoted`. Skips the `smee-attempt` intermediate state that the `rePromoteTimer` path uses.

**Rationale**:

- In runtime bridge mode the smee source is already running and reconnecting on its own. The `rePromoteTimer`'s periodic-retry job (create a new smee source every 5 min) is unnecessary and duplicative.
- A direct `poll-fallback → smee-active` transition tells `doorbell.ts` to close the poll bridge in a single hop, no intermediate re-attempt-then-succeed dance.
- Reason `smee-re-promoted` is already in the `SourceReason` union; reusing it here is semantically clean and preserves the existing log-string vocabulary.

**Alternatives considered**:

- **Force the `rePromoteTimer` to fire immediately when the smee source reconnects mid-bridge**. Rejected — same net effect but two transitions instead of one, and the timer's `smee-attempt` transition would trigger the doorbell's re-start branch (`onModeChange('smee-attempt')`) which recreates the source. That's wrong — the source is already alive.
- **Emit a bespoke `bridge-re-promoted` reason distinct from `smee-re-promoted`**. Rejected — no observable difference from the operator's perspective (either way smee is back); adding a reason string adds vocab without value.

### D5. Startup transient-fail: also uses the bridge (FR-006)

**Decision**: When the initial `startSmeeMode` returns `transient-fail` (discovery non-null, first connect never succeeded), `doorbell.ts` calls `selector.markStartupSmeeFailed()` before `startPollMode()`. The new selector method:

- Transitions `smee-attempt → poll-fallback` synchronously.
- Sets `demotedAt` and starts the `rePromoteTimer`.
- Emits `source=poll-fallback reason=startup-smee-failed` on stderr.
- Adds `'startup-smee-failed'` to the `SourceReason` union.

**Rationale** (from spec FR-006, Q4 → A req):

- Today, on `transient-fail` fallthrough, the selector stays in `smee-attempt` while the doorbell runs poll-mode. The state and reality diverge. Nothing arms the `rePromoteTimer` because `transition()` only starts it on entry to `poll-fallback`.
- Without this fix, a startup-poll doorbell has no route back to smee — a dead end that Q2 → B's removal of the runtime demotion path would otherwise strand.
- A new reason `startup-smee-failed` distinguishes the two "we ended up on poll" origins in logs. Consumers grepping stderr for `source=poll-fallback` are unaffected.

**Alternatives considered**:

- **Reuse `smee-runtime-lost` for the startup case**. Rejected — semantically muddy; the failure never even connected once, so "runtime lost" is a lie.
- **Make the initial construction of `SourceSelector` handle `transient-fail` internally (peek at the first `onReconnectAttempt` count)**. Rejected — pushes doorbell.ts's business logic into the selector; the current explicit `markStartupSmeeFailed()` call site reads better.

### D6. Failure-count threshold: kept at 5

**Decision**: `DEFAULT_DEMOTE_AFTER_FAILURES = 5` unchanged.

**Rationale** (from spec FR-003, Q3 → B):

- "The threshold value may be relaxed but is not critical once the transition is non-terminal." Once the bridge is live-not-terminal, the exact 5-vs-10-vs-20 threshold controls only how quickly we spin up the poll bridge — every value produces the correct end state (bridge open, smee still reconnecting).
- No reason to touch it in a bug-fix PR. Relaxing it would be a follow-up if the bridge spin-up latency turns out to matter.

### D7. Regression test time strategy: fake timers everywhere

**Decision** (from spec FR-007, Q5 → B): `vi.useFakeTimers()` in every FR-007 test. Fake time drives both `Date.now()` (via `vi.setSystemTime`) and the `elapsedTicker`'s `setInterval` together.

**Rationale**:

- The `elapsedTicker` is a `setInterval` under the hood — only fake timers exercise it deterministically. A `now` injection alone leaves the ticker un-fired.
- The three FR-007 scenarios (60-min quiet, keepalives-stop, N failures) are all time-driven state machines; fake timers keep them deterministic and CI-fast.
- Sibling precedent: `smee-source-reconnect.test.ts` already uses `vi.useFakeTimers()` for the reconnect ladder (added by #991). Same idiom, same package, same test framework.

**Alternatives considered**:

- **Compressed thresholds (Q5 → C)**. Rejected — a 100 ms threshold "no demote at 100 ms" test asserts nothing about a ≥60-min contract. Weak proxy.
- **`now` injection only (Q5 → A)**. Rejected — doesn't drive the `setInterval` ticker.

### D8. Test file split: new `doorbell-bridge.test.ts`

**Decision**: FR-007 regression tests go in a new file `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/doorbell-bridge.test.ts`. Selector-only unit cases (byte-liveness refresh, bridge-exit transition, `markStartupSmeeFailed`) go in the existing `source-selector.test.ts`.

**Rationale**:

- Existing `doorbell.test.ts` (`packages/generacy/src/cli/commands/cockpit/__tests__/doorbell.test.ts`) is focused on arg-parsing, discovery, and mode-selection; loading it with fake-timer bridge scenarios would swell it and mix concerns.
- Selector unit tests belong with the selector — they don't need `runDoorbell()` at all.
- Bridge integration tests need to observe the interaction between `SmeeDoorbellSource`'s callback stream and `SourceSelector`'s transitions and `doorbell.ts`'s handle-management. A dedicated file makes that clear.

### D9. Changeset shape

**Decision**: `.changeset/997-doorbell-bridge-mode.md`, `patch` bump for `@generacy-ai/generacy`, `workflow:speckit-bugfix`.

**Rationale** (from CLAUDE.md changeset rules):

- Defect fix (doorbell exits when it shouldn't) → `patch`.
- No new public API surface — `onSseBytes` and `markStartupSmeeFailed` are internal to `packages/generacy/src/cli/commands/cockpit/doorbell/`; the `SourceSelector` class is not re-exported from `index.ts`.
- `workflow:speckit-bugfix` label per CLAUDE.md — this is a bug fix, not a new capability.
- Single package affected; single changeset file.

## Implementation notes

### Selector refactor: `source-selector.ts`

**Constant change**:

```ts
export const DEFAULT_DEMOTE_AFTER_MS_WITHOUT_SUCCESS = 90_000; // was 300_000
```

**Type widening**:

```ts
export type SourceReason =
  | 'startup-no-channel'
  | 'startup-smee-selected'
  | 'startup-smee-failed'      // NEW
  | 'smee-runtime-lost'
  | 'smee-re-promoted';
```

**New public method**:

```ts
onSseBytes(): void {
  if (this.stopped) return;
  if (this._current !== 'smee-active') return;
  this.lastSuccessfulConnectAt = this.now();
}
```

**Extended `onReconnectSuccess`** (runtime bridge-exit path):

```ts
onReconnectSuccess(): void {
  if (this.stopped) return;
  this.consecutiveReconnectFailures = 0;
  this.lastSuccessfulConnectAt = this.now();
  if (this._current === 'smee-attempt') {
    // ... existing behaviour unchanged
  } else if (this._current === 'poll-fallback') {
    // Bridge exit: runtime smee reconnected. Skip smee-attempt.
    if (this.rePromoteTimer != null) {
      clearInterval(this.rePromoteTimer);
      this.rePromoteTimer = null;
    }
    this.transition('smee-active', 'smee-re-promoted');
  }
}
```

**New public method** (startup fall-through):

```ts
markStartupSmeeFailed(): void {
  if (this.stopped) return;
  if (this._current !== 'smee-attempt') return;
  this.transition('poll-fallback', 'startup-smee-failed');
}
```

Note: `transition('poll-fallback', ...)` already starts `rePromoteTimer` when `initialWasSmee` is true (line 150-156). No extra wiring needed.

### `SmeeDoorbellSource` refactor: `smee-source.ts`

**Type widening**:

```ts
export interface SmeeDoorbellSourceOptions {
  // ... existing fields
  /** Optional callback fired on every inbound SSE-stream byte read (keepalives + payloads). */
  onSseBytes?: () => void;
}
```

**Store on class** (constructor):

```ts
private readonly onSseBytes?: () => void;

constructor(options: SmeeDoorbellSourceOptions) {
  // ... existing assignments
  if (options.onSseBytes != null) this.onSseBytes = options.onSseBytes;
}
```

**Wire callback in `connect()`'s reader loop** (only change to `connect()`):

```ts
while (!signal.aborted) {
  const { done, value } = await reader.read();
  if (done) break;

  if (this.onSseBytes != null && value != null && value.length > 0) {
    try { this.onSseBytes(); } catch { /* swallow */ }
  }

  buffer += decoder.decode(value, { stream: true });
  // ... existing event-block handling
}
```

Callback invocation is `try/catch`-guarded to match the pattern used for the other callbacks (`onReconnectAttempt`, `onReconnectSuccess`).

### Doorbell refactor: `doorbell.ts`

**Wire `onSseBytes` in `runSmeeMode`** (after existing `onReconnectAttempt`/`onReconnectSuccess`):

```ts
const sourceOptions: ConstructorParameters<typeof SmeeDoorbellSource>[0] = {
  channelUrl: input.channelUrl,
  epicRef: input.ref,
  gh,
  logger: input.logger,
  onEvent,
  onReconnectAttempt: (n) => input.selector.onReconnectAttempt(n),
  onReconnectSuccess: () => input.selector.onReconnectSuccess(),
  onSseBytes: () => input.selector.onSseBytes(),
};
```

**Rewrite the `onModeChange` handler**:

```ts
selector.onModeChange((next: SourceMode) => {
  if (next === 'poll-fallback') {
    // BRIDGE OPEN: keep smee source running in the background; add poll snapshots alongside.
    void (async (): Promise<void> => {
      const outcome = await startPollMode();
      if (outcome === 'permanent-exit') {
        permanentExit = true;
        stop();
      } else if (outcome === 'transient-fail') {
        stop();
      }
    })();
  } else if (next === 'smee-active') {
    // BRIDGE EXIT: smee reconnected during runtime demotion. Close poll bridge.
    if (pollHandle != null) {
      const p = pollHandle;
      pollHandle = null;
      p.release();
    }
  } else if (next === 'smee-attempt' && discovery != null) {
    // Startup-transient-fail rePromoteTimer path (unchanged shape).
    void (async (): Promise<void> => {
      if (pollHandle != null) {
        const p = pollHandle;
        pollHandle = null;
        p.release();
      }
      const outcome = await startSmeeMode(discovery.url);
      if (outcome === 'permanent-exit') {
        permanentExit = true;
        stop();
      } else if (outcome === 'transient-fail') {
        const pollOutcome = await startPollMode();
        if (pollOutcome === 'permanent-exit') {
          permanentExit = true;
          stop();
        } else if (pollOutcome === 'transient-fail') stop();
      }
    })();
  }
});
```

**Startup transient-fail fallthrough** (line 533 area):

```ts
if (outcome === 'transient-fail') {
  selector.markStartupSmeeFailed();  // NEW — arms rePromoteTimer, emits startup-smee-failed line
  const pollOutcome = await startPollMode();
  // ... existing outcome handling
}
```

## References

- `packages/generacy/src/cli/commands/cockpit/doorbell/source-selector.ts:29-32, 89-128, 143-195` — existing state machine.
- `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts:248-330` — existing reconnect loop + reader.
- `packages/generacy/src/cli/commands/cockpit/doorbell.ts:411-578` — existing selector wiring, `onModeChange` handler, startup fall-through.
- `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/source-selector.test.ts:91-127` — sibling `vi.useFakeTimers()` precedent for re-promote timer.
- `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/smee-source-reconnect.test.ts` — sibling fake-timer test on the reconnect loop (#991).
- clarifications.md Q1–Q5 answers.
