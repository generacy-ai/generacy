# Data Model: Cockpit GraphQL rate-limit exhaustion

## New types (in `@generacy-ai/cockpit`)

### `GhCacheOptions`

```ts
export interface GhCacheOptions {
  /** TTL for cached entries in milliseconds. Default 20_000. */
  ttlMs?: number;
  /** Wall-clock provider (test seam). */
  now?: () => number;
  /** Optional debug logger — never called in the hot path. */
  logger?: { debug?: (msg: string) => void };
}
```

### `GhResponseCache`

```ts
export interface GhResponseCache {
  /**
   * Read-through: return cached value if present + fresh; otherwise invoke
   * fetcher(), cache its result, and return. Concurrent misses for the same
   * key share a single in-flight fetcher (Promise deduplication).
   */
  getOrFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T>;

  /** Remove a single entry immediately. */
  invalidate(key: string): void;

  /**
   * Remove every entry whose key starts with `prefix`. Used by write paths
   * whose blast radius spans multiple methods (e.g. mergePullRequest).
   */
  invalidatePrefix(prefix: string): void;

  /** Test-only observability. Not called in production. */
  size(): number;
}
```

**Key format** (convention, not enforced): `${methodName}:${repo}#${number}`.
Examples:
- `getPullRequestCheckRuns:generacy-ai/generacy#970`
- `getIssue:generacy-ai/generacy#970`
- `resolveIssueToPR:generacy-ai/generacy#970`
- `getPullRequest:generacy-ai/generacy#970`

### `RateLimitSchedulerOptions`

```ts
export interface RateLimitSchedulerOptions {
  /** Base poll interval in milliseconds. Default 30_000. */
  baseIntervalMs?: number;
  /** Absolute upper bound on the widened interval. Default 300_000 (5 min). */
  ceilingMs?: number;
  /** Cadence for the /rate_limit probe when budget is healthy. Default 300_000. */
  probeCadenceMs?: number;
  /** Cadence for the /rate_limit probe when budget is low. Default 60_000. */
  fastProbeCadenceMs?: number;
  /**
   * Threshold below which we switch to fast probes AND begin widening the
   * poll interval. Default 0.20 (i.e. remaining < 20% of graphql limit).
   */
  lowWatermarkRatio?: number;
  /**
   * Threshold below which we quadruple the poll interval. Default 0.05.
   */
  criticalWatermarkRatio?: number;
  /**
   * Threshold at/above which we reset to base interval + slow probes.
   * Must be strictly greater than lowWatermarkRatio (hysteresis). Default 0.30.
   */
  resetWatermarkRatio?: number;
  /** Command runner (reuses the one owned by GhCliWrapper). */
  runner?: CommandRunner;
  /** Wall-clock provider (test seam). */
  now?: () => number;
  /** Optional structured logger. */
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}
```

### `RateLimitProbeResult`

```ts
export interface RateLimitProbeResult {
  /** Remaining graphql points. */
  remaining: number;
  /** Total graphql limit (typically 5000). */
  limit: number;
  /** Unix epoch seconds when the graphql bucket resets. */
  resetAt: number;
}
```

### `RateLimitScheduler`

```ts
export interface RateLimitScheduler {
  /** Current poll interval in milliseconds, subject to ladder + retry-after. */
  getCurrentIntervalMs(): number;

  /**
   * Invoke `gh api rate_limit` and update state. Callable ad-hoc from tests
   * or on 403 recovery.
   */
  probeNow(): Promise<RateLimitProbeResult | null>;

  /** Called when a response surfaces retry-after (opportunistic path). */
  noteRetryAfter(seconds: number): void;

  /** Called opportunistically when a response includes x-ratelimit-* headers. */
  noteResponseHeaders(headers: Record<string, string>): void;

  /** Arm the periodic probe timer. Idempotent. */
  start(): void;

  /** Clear the periodic probe timer. Idempotent. */
  stop(): void;
}
```

## Modified types (in `@generacy-ai/cockpit`)

### `PullRequestSummary` — add `headRefOid`

```ts
export interface PullRequestSummary {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedAt?: string;
  closedAt?: string;
  url: string;
  isDraft: boolean;
  labels: string[];
  /** SHA of the head ref. Sourced from `--json headRefOid`. New in #970. */
  headRefOid?: string;
}
```

`headRefOid` is optional so existing callers that receive a `PullRequestSummary` from stub/mock paths (older test doubles) still compile. The wrapper always populates it going forward.

### `GhCliWrapper` — new constructor options

```ts
export class GhCliWrapper implements GhWrapper {
  constructor(
    runner?: CommandRunner,
    logger?: GhWrapperLogger,
    options?: {
      cache?: GhResponseCache;               // optional; if omitted, no caching
      rateLimitScheduler?: RateLimitScheduler; // optional; if omitted, no probe
    },
  );
}
```

Both options default to undefined — a bare `new GhCliWrapper(runner)` retains today's behavior exactly.

## New types (in `@generacy-ai/generacy` — internal)

### `PrSnapshot` — extend with head-ref-OID + cycle counter

```ts
export interface PrSnapshot {
  kind: 'pr';
  repo: string;
  number: number;
  url: string;
  lifecycle: PrLifecycle;
  state: 'OPEN' | 'CLOSED';
  stateReason: 'COMPLETED' | 'NOT_PLANNED' | null;
  labels: string[];
  classified: ClassifiedIssue;
  checksRollup: ChecksRollup;
  /** SHA of the head ref at last observation. Undefined until first getPullRequest. */
  headRefOid?: string;
  /** Cycles elapsed since the last getPullRequestCheckRuns call. Starts at 0. */
  cyclesSinceLastCheckFetch: number;
}
```

`IssueSnapshot` is unchanged.

### `PrChecksNeededDecision`

```ts
export type PrChecksNeededReason =
  | 'no-prev'
  | 'lifecycle-flip'
  | 'head-changed'
  | 'label-changed'
  | 'safety-cycle'
  | 'not-terminal'
  | 'skip-terminal';

export interface PrChecksNeededDecision {
  fetch: boolean;
  reason: PrChecksNeededReason;
}
```

Not exported from `@generacy-ai/cockpit`; internal to `@generacy-ai/generacy`.

### `PollDeps` — extend with cycle counter + scheduler

```ts
export interface PollDeps {
  gh: GhWrapper;
  refs: IssueRef[];
  epicOwnerRepo: string;
  safetyCap?: number;
  pageSize?: number;
  logger?: { warn: (msg: string) => void };
  now?: () => string;
  /** Monotonic cycle counter; used by the check-runs safety re-fetch gate. */
  cycleNumber?: number;
}
```

`cycleNumber` is optional to keep existing tests compiling; when omitted, the safety-cycle branch never fires.

### `PauseState` — extend with `skipNextCycle`

```ts
interface PauseState {
  paused: boolean;
  resumeResolver: (() => void) | null;
  /** One-shot flag: skip the immediate next `runCycle` after a catch-up poll. */
  skipNextCycle: boolean;
}
```

## Validation rules

- `GhCacheOptions.ttlMs` — must be positive; runtime validated at construction, not per-call.
- `RateLimitSchedulerOptions` — `resetWatermarkRatio > lowWatermarkRatio > criticalWatermarkRatio > 0`. Fail-loud at construction (throw with a specific message).
- `RateLimitProbeResult.remaining` — clamped to `[0, limit]` post-parse.
- `PrSnapshot.cyclesSinceLastCheckFetch` — always `>= 0`; incremented once per poll cycle where `derivePrChecksNeeded()` returned `fetch: false`; reset to 0 after a fetch.
- Key strings for the cache — no runtime validation; convention documented in JSDoc.

## Relationships

```
GhCliWrapper ─── owns ──► GhResponseCache
                    │
                    └─── owns ──► RateLimitScheduler (optional)
                                       │
                                       └─── uses ──► CommandRunner (runs `gh api rate_limit`)

runOnePoll ─── consumes ──► GhCliWrapper (via PollDeps.gh)
                    │
                    └─── consumes ──► derivePrChecksNeeded (pure function)
                                             │
                                             └─── reads ──► prev PrSnapshot
                                             └─── reads ──► current PullRequestSummary.headRefOid

acquireEpicBus / releaseKey ─── mutates ──► PauseState.skipNextCycle
runPollLoop ─── reads + clears ──► PauseState.skipNextCycle

watch.ts loop ─── reads ──► scheduler.getCurrentIntervalMs()  (once per iteration)
event-bus runPollLoop ─── reads ──► scheduler.getCurrentIntervalMs()
```

## Serialization

- Nothing in this feature is persisted to disk.
- `PrSnapshot.headRefOid` and `cyclesSinceLastCheckFetch` live in-memory in the poll state map (`SnapshotMap`). They do not appear in NDJSON output from `cockpit watch` (which emits transition events, not snapshots).
- `RateLimitScheduler` state is not serialized. Cluster restart resets to base interval + immediate probe.
- Cache is per-process; no cross-restart survival.
