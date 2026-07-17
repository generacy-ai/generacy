# Contract: `StartupRetrySchedule` — doorbell startup resilience (FR-003, FR-004, FR-005)

**Module**: `packages/generacy/src/cli/commands/cockpit/doorbell/startup-retry.ts` (new)

## Purpose

Wrap the two doorbell startup `gh` call sites (`acquireEpicBus` in poll
mode, `resolveEpic` inside `SmeeDoorbellSource.start()`) in a retry
envelope that survives transient errors and exits distinctively on
permanent ones. Replaces today's silent `exit(2)` on first-hiccup failure.

## Public API

```ts
export function runStartupRetry<T>(opts: StartupRetryOptions<T>): Promise<StartupRetryOutcome<T>>;

export function classifyGhError(err: unknown): GhErrorClass;
```

See `data-model.md` for the full option and outcome types.

## Behavior

### Initial retry window (~2 min)

`runStartupRetry` calls `opts.task()`. On thrown error:

1. `classifyGhError(err)` produces `GhErrorClass`.
2. If `kind: 'permanent'`:
   - Emit one stderr line: `cockpit doorbell: permanent-error label=<label>
     reason=<reason>\n`.
   - Resolve `{ kind: 'permanent', reason }`.
3. If `kind: 'retriable'`:
   - On first retriable failure: emit `cockpit doorbell: startup-retry
     label=<label> reason=<hint> attempt=1\n`.
   - If `now() - startedAt >= initialWindowMs`, transition to
     late-window (see below).
   - Else: sleep `rateLimitScheduler.getCurrentIntervalMs()`, then retry.
     Also call `rateLimitScheduler.noteResponseHeaders({})` (best-effort
     hook that lets the scheduler's watermark logic advance).
   - Task attempt count is tracked; each subsequent retry logs its own
     attempt-N line at `info` level (not stderr).

Between attempts, `runStartupRetry` observes `abortSignal`. If aborted
during a sleep, resolve `{ kind: 'aborted' }`.

### Late-window transition (~5 min cadence)

When the initial window is exhausted without success:

1. Emit stderr: `cockpit doorbell: startup-retry-exhausted label=<label>
   transitioning to late-startup retry\n`.
2. Sleep `lateWindowIntervalMs` (default 300_000). Retry `task()`.
3. On success: emit `cockpit doorbell: startup-retry-recovered
   label=<label>\n`. Resolve `{ kind: 'success', value }`.
4. On retriable failure: log at `info`, sleep, retry.
5. On permanent failure: emit permanent-error line as above; resolve
   `{ kind: 'permanent', reason }`.
6. On abort during sleep: resolve `{ kind: 'aborted' }`.

### Never-`exit(2)` invariant

`runStartupRetry` never exits the process. It resolves one of the three
outcomes. The caller (`runDoorbell`) decides:

- `success` → continue startup (subscribe, run wake loop).
- `permanent` → exit `3`.
- `aborted` → exit `0` (normal shutdown path).

## Error classifier — `classifyGhError`

Pure function; no I/O. Deterministic mapping from an `unknown` thrown by
`gh` call sites to `GhErrorClass`.

**Retriable** (in evaluation order):

1. `err.code` string ∈ `{ ECONNRESET, ETIMEDOUT, ENOTFOUND,
   ECONNREFUSED, EPIPE }` → `{ kind: 'retriable', hint: '<lowercase-code>' }`.
2. Message matches `/socket hang up/i` → `{ kind: 'retriable', hint:
   'socket-hang-up' }`.
3. Message contains an HTTP status marker in `{ 429, 500, 502, 503, 504 }`
   (matches `/\bHTTP\s+(429|500|502|503|504)\b/`) → `{ kind: 'retriable',
   hint: 'http-<status>' }`.

**Permanent** (in evaluation order after retriable rules fail):

1. Message matches `/\bHTTP\s+401\b/` or `/Bad credentials/i` → `{ kind:
   'permanent', reason: 'bad-credentials' }`.
2. Message matches `/\bHTTP\s+403\b/` or `/SAML|scope|not accessible by/i`
   → `{ kind: 'permanent', reason: 'scope-or-sso' }`.
3. Message matches `/\bHTTP\s+404\b/` or `/Could not resolve to (an
   Issue|a Repository)/i` → `{ kind: 'permanent', reason: 'not-found' }`.
4. Message matches `/parsing|expected JSON|invalid character/i` → `{ kind:
   'permanent', reason: 'malformed-output' }`.
5. Default → `{ kind: 'permanent', reason: 'unknown' }`.

## Integration in `runDoorbell`

`runPollMode` (`doorbell.ts:136-155`):

```ts
const outcome = await runStartupRetry({
  task: () => acquire(acquireOptions),
  label: 'acquireEpicBus',
  rateLimitScheduler: input.deps.rateLimitScheduler!,
  abortSignal: input.stopSignalController.signal,
  stderr: input.stderr,
  logger: input.logger,
});
if (outcome.kind === 'permanent') return { kind: 'permanent-exit' };
if (outcome.kind === 'aborted') return null;
const acquired = outcome.value as Acquired;
```

`runSmeeMode` (`doorbell.ts:199-242`):

```ts
const outcome = await runStartupRetry({
  task: async () => { await source.start(); return null; },
  label: 'resolveEpic',
  rateLimitScheduler: input.deps.rateLimitScheduler!,
  abortSignal: input.stopSignalController.signal,
  stderr: process.stderr,
  logger: input.logger,
});
if (outcome.kind === 'permanent') return { kind: 'permanent-exit' };
if (outcome.kind === 'aborted') return null;
```

`runDoorbell` collapses a `permanent-exit` marker returned from either
sub-mode into `exit(3)`; today's `exit(2)` code path is preserved only for
argument parsing errors (unchanged).

## Guarantees

- **Never `exit(2)` on transient failure.** Only the "unhandled outer
  error" or argument-parse failure paths still exit `2`.
- **Distinct diagnostic on permanent failure.** stderr line prefix
  `cockpit doorbell: permanent-error label=<label> reason=<reason>` is
  distinguishable from all pre-existing lines.
- **Bounded `gh` cost when degraded.** Late-window retry at 5-min cadence
  ≈ 12 calls/hour per call site; overall ceiling ≈ 24/hour.
- **Signal-safe.** Retry loops observe `abortSignal`; SIGINT/SIGTERM
  during a retry sleep resolves `{ kind: 'aborted' }` promptly.

## Test scaffolding

New Vitest specs in `__tests__/startup-retry.test.ts`:

1. Task succeeds first attempt → `{ kind: 'success', value }`; no stderr
   lines emitted beyond upstream ones.
2. Task throws ECONNRESET, then succeeds → one attempt-1 stderr line;
   final `{ kind: 'success' }` after one sleep.
3. Task throws HTTP 429 for the entire initial window, then succeeds in
   late-window → transitions logged; `{ kind: 'success' }` after
   `initialWindowMs + lateWindowIntervalMs` elapsed (fake timers).
4. Task throws HTTP 401 → `{ kind: 'permanent', reason: 'bad-credentials'
   }`; stderr line emitted.
5. Task throws HTTP 403 with SAML text → `{ reason: 'scope-or-sso' }`.
6. Task throws HTTP 404 → `{ reason: 'not-found' }`.
7. Task throws malformed JSON error → `{ reason: 'malformed-output' }`.
8. Task throws unknown message → `{ reason: 'unknown' }`.
9. `abortSignal` fires mid-initial-window sleep → `{ kind: 'aborted' }`.
10. `abortSignal` fires mid-late-window sleep → `{ kind: 'aborted' }`.
11. `classifyGhError` unit table covering every branch of the classifier.
12. `runDoorbell` integration: `acquireEpicBus` throws once with
    ECONNRESET, then resolves — doorbell reaches steady state; asserts
    `armed\n` was already flushed before the retry attempt (unchanged
    ordering).

## Deferred / out of scope

- Retrying **non-startup** `gh` calls (SSE reconnect, ref-set refresh).
  Runtime `gh` calls already have their own retry paths in
  `SmeeDoorbellSource` and `rateLimitScheduler`.
- Cross-run persistence of "permanently failing" state — a permanent-error
  exit is one-shot per doorbell process; the agency skill can log it but
  won't re-spawn (that's the passive contract).
- Rich structured logs (`pino` JSON). The doorbell surface uses plain
  stderr lines today; matching that shape.
