# Contract: `RateLimitScheduler`

Owns the current poll interval as a function of GitHub GraphQL rate-limit budget. Unified proactive-widening + reactive backoff per clarification Q4=C.

## Public API

```ts
export interface RateLimitSchedulerOptions {
  baseIntervalMs?: number;            // default 30_000
  ceilingMs?: number;                 // default 300_000 (5 min)
  probeCadenceMs?: number;            // default 300_000
  fastProbeCadenceMs?: number;        // default 60_000
  lowWatermarkRatio?: number;         // default 0.20
  criticalWatermarkRatio?: number;    // default 0.05
  resetWatermarkRatio?: number;       // default 0.30
  runner?: CommandRunner;             // required to actually probe
  now?: () => number;
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}

export interface RateLimitProbeResult {
  remaining: number;
  limit: number;
  resetAt: number;
}

export interface RateLimitScheduler {
  getCurrentIntervalMs(): number;
  probeNow(): Promise<RateLimitProbeResult | null>;
  noteRetryAfter(seconds: number): void;
  noteResponseHeaders(headers: Record<string, string>): void;
  start(): void;
  stop(): void;
}

export function createRateLimitScheduler(opts?: RateLimitSchedulerOptions): RateLimitScheduler;
```

## Ladder

Let `r = remaining / limit`. Let `base = baseIntervalMs`, `ceiling = ceilingMs`.

| Condition | Interval |
|---|---|
| `retryAfterUntilMs > now()` | `min(retryAfterUntilMs - now(), ceiling)` (retry-after wins) |
| `r >= resetWatermarkRatio` (default 0.30) | `base` |
| `r < lowWatermarkRatio && r >= criticalWatermarkRatio` (0.20 > r >= 0.05) | `2 * base` (clamped to ceiling) |
| `r < criticalWatermarkRatio` (default 0.05) | `4 * base` (clamped to ceiling) |
| otherwise (0.20 <= r < 0.30) | previous interval (hysteresis band) |

## Probe cadence

- Slow (`probeCadenceMs`, default 5 min) while `r >= lowWatermarkRatio`.
- Fast (`fastProbeCadenceMs`, default 1 min) while `r < lowWatermarkRatio`.
- Switching between cadences reschedules the timer immediately (no gap).

## `probeNow()` semantics

- Invokes `gh api rate_limit` via the injected `runner`.
- Parses response JSON's `resources.graphql.{remaining, limit, reset}`.
- On success: updates internal state, returns the parsed triple.
- On any failure (non-zero exit, malformed JSON, network error): logs warn, returns `null`. Interval stays at last-known value; probe timer keeps ticking.

## `noteRetryAfter(seconds)`

- Sets `retryAfterUntilMs = now() + seconds * 1000`, clamped so `retryAfterUntilMs - now() <= ceilingMs`.
- Interval reverts to ladder once `retryAfterUntilMs <= now()`.

## `noteResponseHeaders(headers)`

- Opportunistic. Reads `x-ratelimit-remaining` and `x-ratelimit-limit` if present. Reads `retry-after` if present (integer seconds).
- Never called from the hot path today (shell-out to `gh pr checks` / `gh issue view` drops headers). Future path via `gh api -i` could call this.

## `start()` / `stop()`

- `start()`: arms the probe timer with the current cadence. Idempotent — calling again is a no-op unless already stopped.
- `stop()`: clears the timer. Idempotent. Interval reads return the last-known value.
- Timer uses `.unref()` when available so it doesn't keep the process alive in CLI mode.

## Invariants

- **I-1**: `getCurrentIntervalMs() >= baseIntervalMs` at all times.
- **I-2**: `getCurrentIntervalMs() <= ceilingMs` at all times.
- **I-3**: `retry-after` always wins over ladder while it's in effect.
- **I-4**: Hysteresis — an interval that widened due to `r < 0.20` does NOT return to base until `r >= 0.30`.
- **I-5**: Failed probes never change the interval.

## Validation at construction

- `resetWatermarkRatio > lowWatermarkRatio > criticalWatermarkRatio > 0` — throws with a specific message on violation.
- `ceilingMs >= baseIntervalMs` — throws on violation.
- `probeCadenceMs > 0`, `fastProbeCadenceMs > 0`.

## Test seams

- `now: () => number` for the retry-after clock and probe cadence.
- `runner` — inject a fake that produces canned `gh api rate_limit` responses.
- `probeNow()` returns the parsed result — assertable directly.

## Non-goals

- Not per-token: one process = one scheduler. Multi-token orchestration is out of scope.
- Not thread-safe: single-threaded on Node event loop.
- Not persistent: cluster restart resets state.
