/**
 * Per-orchestrator-process registry of `EpicEventBus` instances, keyed by
 * epic-ref string (`"owner/repo#number"`).
 *
 * Each bus is driven by a private poller — mirrors `watch.ts` but emits into
 * the bus instead of stdout NDJSON. Multiple concurrent `cockpit_await_events`
 * callers against the same epic share the subscriber; refcounted via
 * `acquire` / `release`.
 *
 * Bus lifetime is decoupled from call lifetime (#924): `release()` at
 * refcount 0 pauses the poller and arms an idle-TTL timer instead of tearing
 * down the bus. The next `acquire()` disarms the timer, resumes the poller,
 * and runs a synchronous catch-up poll so between-call events are captured.
 * A soft cap on live buses evicts the least-recently-active on overflow.
 *
 * Env knobs:
 *   `COCKPIT_MCP_BUS_IDLE_TTL_MS` — idle-TTL for refcount-0 buses (default 600_000).
 *   `COCKPIT_MCP_BUS_MAX`         — soft cap on live buses (default 100).
 */
import {
  GhCliWrapper,
  LoudResolverError,
  resolveEpic,
  type CommandRunner,
  type GhWrapper,
  type RateLimitScheduler,
  type ResolvedEpic,
} from '@generacy-ai/cockpit';
import { resolveIssueContext } from '../resolver.js';
import { runOnePoll } from '../watch/poll-loop.js';
import {
  computeAggregateEvents,
  initialAggregateState,
  type AggregateState,
} from '../watch/aggregate.js';
import type { SnapshotMap } from '../watch/snapshot.js';
import type { CockpitStreamEvent } from '../watch/stream-event.js';
import { EpicEventBus } from './event-bus.js';

const DEFAULT_INTERVAL_MS = 30_000;

/** Env knob `COCKPIT_MCP_BUS_IDLE_TTL_MS` — idle-TTL for refcount-0 buses. */
const DEFAULT_IDLE_TTL_MS = 600_000;
/** Env knob `COCKPIT_MCP_BUS_MAX` — soft cap on live buses. */
const DEFAULT_MAX_BUSES = 100;

const EPIC_REFRESH_CYCLES = 10;

function parsePositiveIntEnv(
  raw: string | undefined,
  fallback: number,
  name: string,
  logger?: { warn: (msg: string) => void },
): number {
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    logger?.warn(`event-bus: invalid ${name}=${raw}; using default ${fallback}`);
    return fallback;
  }
  return n;
}

interface PollState {
  prev: SnapshotMap;
  aggState: AggregateState;
  firstPoll: boolean;
  currentResolved: ResolvedEpic | null;
  cyclesSinceEpicRefresh: number;
}

interface Subscription {
  bus: EpicEventBus;
  refCount: number;
  stop: () => void;
  pausePoller: () => void;
  resumePoller: () => void;
  catchUpPoll: () => Promise<void>;
  markSkipNextCycle: () => void;
  idleTimer: NodeJS.Timeout | null;
  lastActiveAt: number;
  /** TTL captured at first acquire; used by `releaseKey` to arm the timer. */
  idleTtlMs: number;
  /** Structured logger captured from the first acquire; reused on eviction. */
  logger: { warn: (msg: string) => void; info?: (msg: string) => void };
}

const registry = new Map<string, Subscription>();

export interface AcquireOptions {
  epicRef: string;
  runner?: CommandRunner;
  gh?: GhWrapper;
  intervalMs?: number;
  rateLimitScheduler?: RateLimitScheduler;
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
  /**
   * Injection seam for tests: build an event bus without starting a poll
   * loop. Callers use the returned bus's `emit()` directly.
   */
  noPoll?: boolean;
  /** Test seam: wall-clock provider (drives `lastActiveAt`). */
  now?: () => number;
  /** Test seam: override the idle-TTL for this and subsequent acquires. */
  idleTtlMs?: number;
  /** Test seam: override the LRU soft cap for this and subsequent acquires. */
  maxBuses?: number;
  /**
   * Test seam: replace the entire poll cycle (resolveEpic + runOnePoll +
   * computeAggregateEvents). Called from both the poll loop and
   * `catchUpPoll()`. Used to drive between-call event emission
   * deterministically in unit tests.
   */
  runCycle?: (bus: EpicEventBus) => Promise<void>;
}

export interface Acquired {
  bus: EpicEventBus;
  release: () => void;
}

export async function acquireEpicBus(options: AcquireOptions): Promise<Acquired> {
  const expandedRef = await expandRef(options.epicRef, options.runner);
  const now = options.now ?? Date.now;
  const logger = options.logger ?? { warn: () => undefined };
  const idleTtlMs = parsePositiveIntEnv(
    process.env.COCKPIT_MCP_BUS_IDLE_TTL_MS,
    options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
    'COCKPIT_MCP_BUS_IDLE_TTL_MS',
    logger,
  );
  const maxBuses = parsePositiveIntEnv(
    process.env.COCKPIT_MCP_BUS_MAX,
    options.maxBuses ?? DEFAULT_MAX_BUSES,
    'COCKPIT_MCP_BUS_MAX',
    logger,
  );

  const existing = registry.get(expandedRef);
  if (existing != null) {
    const wasPaused = existing.refCount === 0;
    if (existing.idleTimer != null) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
    }
    existing.refCount += 1;
    existing.lastActiveAt = now();
    // Reinsert at tail for LRU ordering.
    registry.delete(expandedRef);
    registry.set(expandedRef, existing);
    // Catch-up only runs when the poller was paused (refcount had been 0);
    // concurrent-caller acquires (refcount was already > 0) skip it.
    if (wasPaused) {
      await existing.catchUpPoll();
      existing.markSkipNextCycle();
      existing.resumePoller();
    }
    return { bus: existing.bus, release: () => releaseKey(expandedRef) };
  }

  // New bus. Evict LRU if at soft cap.
  if (registry.size >= maxBuses) {
    const evictedKey = registry.keys().next().value;
    if (evictedKey != null) {
      const evicted = registry.get(evictedKey);
      if (evicted != null) {
        if (evicted.idleTimer != null) clearTimeout(evicted.idleTimer);
        evicted.stop();
        registry.delete(evictedKey);
        logger.warn(`event-bus: LRU eviction of ${evictedKey} at cap ${maxBuses}`);
      }
    }
  }

  const bus = new EpicEventBus({ epic: expandedRef });

  if (options.noPoll === true && options.runCycle == null) {
    const sub: Subscription = {
      bus,
      refCount: 1,
      stop: () => undefined,
      pausePoller: () => undefined,
      resumePoller: () => undefined,
      catchUpPoll: async () => undefined,
      markSkipNextCycle: () => undefined,
      idleTimer: null,
      lastActiveAt: now(),
      idleTtlMs,
      logger,
    };
    registry.set(expandedRef, sub);
    return { bus, release: () => releaseKey(expandedRef) };
  }

  const gh = options.gh ?? new GhCliWrapper(options.runner);
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const scheduler = options.rateLimitScheduler;
  scheduler?.start();

  const state: PollState = {
    prev: new Map(),
    aggState: initialAggregateState(),
    firstPoll: true,
    currentResolved: null,
    cyclesSinceEpicRefresh: 0,
  };

  const controller = new AbortController();
  const pauseState: PauseState = {
    paused: false,
    resumeResolver: null,
    skipNextCycle: false,
  };

  const runCycle = options.runCycle
    ? () => options.runCycle!(bus)
    : () => runRealCycle(bus, expandedRef, gh, state, logger);

  const catchUpPoll = async (): Promise<void> => {
    try {
      await runCycle();
      logger.info?.(`event-bus: catch-up poll for ${expandedRef}`);
    } catch (err) {
      logger.warn(
        `event-bus: catch-up poll failed for ${expandedRef}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const stop = (): void => {
    controller.abort();
    scheduler?.stop();
    // Also wake any pending resume waiter so the loop exits promptly.
    if (pauseState.resumeResolver != null) {
      const r = pauseState.resumeResolver;
      pauseState.resumeResolver = null;
      r();
    }
  };

  const pausePoller = (): void => {
    pauseState.paused = true;
  };
  const resumePoller = (): void => {
    if (!pauseState.paused) return;
    pauseState.paused = false;
    if (pauseState.resumeResolver != null) {
      const r = pauseState.resumeResolver;
      pauseState.resumeResolver = null;
      r();
    }
  };
  const markSkipNextCycle = (): void => {
    pauseState.skipNextCycle = true;
  };

  const sub: Subscription = {
    bus,
    refCount: 1,
    stop,
    pausePoller,
    resumePoller,
    catchUpPoll,
    markSkipNextCycle,
    idleTimer: null,
    lastActiveAt: now(),
    idleTtlMs,
    logger,
  };
  registry.set(expandedRef, sub);

  // Kick off the poll loop unless the caller opted out (`noPoll` with a
  // custom `runCycle` is a valid test config — the loop is still needed).
  if (options.noPoll !== true) {
    void runPollLoop(runCycle, interval, controller.signal, pauseState, logger, scheduler);
  }

  return { bus, release: () => releaseKey(expandedRef) };
}

interface PauseState {
  paused: boolean;
  resumeResolver: (() => void) | null;
  skipNextCycle: boolean;
}

function releaseKey(key: string): void {
  const sub = registry.get(key);
  if (sub == null) return;
  sub.refCount -= 1;
  if (sub.refCount > 0) return;
  sub.pausePoller();
  sub.idleTimer = setTimeout(() => {
    // Guarded: an acquire may have raced in during the tick.
    const current = registry.get(key);
    if (current == null || current !== sub) return;
    if (current.refCount > 0) return;
    current.stop();
    registry.delete(key);
    (current as { idleTimer: NodeJS.Timeout | null }).idleTimer = null;
    current.logger.info?.(`event-bus: idle-TTL eviction of ${key}`);
  }, sub.idleTtlMs);
  if (sub.idleTimer.unref) sub.idleTimer.unref();
}

async function expandRef(input: string, runner: CommandRunner | undefined): Promise<string> {
  const resolved = await resolveIssueContext({
    issue: input,
    ...(runner != null ? { runner } : {}),
  });
  return `${resolved.ref.nwo}#${resolved.ref.number}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function waitForResume(pauseState: PauseState, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted || !pauseState.paused) {
      resolve();
      return;
    }
    pauseState.resumeResolver = resolve;
    signal.addEventListener(
      'abort',
      () => {
        if (pauseState.resumeResolver === resolve) {
          pauseState.resumeResolver = null;
          resolve();
        }
      },
      { once: true },
    );
  });
}

async function runPollLoop(
  runCycle: () => Promise<void>,
  interval: number,
  signal: AbortSignal,
  pauseState: PauseState,
  logger: { warn: (msg: string) => void },
  scheduler: RateLimitScheduler | undefined,
): Promise<void> {
  while (!signal.aborted) {
    if (pauseState.paused) {
      await waitForResume(pauseState, signal);
      if (signal.aborted) break;
      continue;
    }
    if (pauseState.skipNextCycle) {
      pauseState.skipNextCycle = false;
      const activeInterval = scheduler?.getCurrentIntervalMs() ?? interval;
      await sleep(activeInterval, signal);
      continue;
    }
    try {
      await runCycle();
    } catch (err) {
      logger.warn(
        `event-bus: poll error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (signal.aborted) break;
    if (pauseState.paused) continue;
    const activeInterval = scheduler?.getCurrentIntervalMs() ?? interval;
    await sleep(activeInterval, signal);
  }
}

async function runRealCycle(
  bus: EpicEventBus,
  expandedRef: string,
  gh: GhWrapper,
  state: PollState,
  logger: { warn: (msg: string) => void },
): Promise<void> {
  let justFetched = false;
  if (state.currentResolved == null) {
    try {
      state.currentResolved = await resolveEpic({ epicRef: expandedRef, gh, logger });
      justFetched = true;
    } catch (err) {
      if (err instanceof LoudResolverError) {
        logger.warn(`event-bus: resolveEpic failed: ${err.message}`);
      } else {
        logger.warn(`event-bus: resolveEpic failed: ${String(err)}`);
      }
      return;
    }
  }

  const resolved = state.currentResolved;
  const result = await runOnePoll(state.prev, {
    gh,
    refs: resolved.parsed.allRefs,
    epicOwnerRepo: resolved.epic.repo,
    logger,
  });
  for (const event of result.events) {
    bus.emit({ ...event, type: 'issue-transition' } as CockpitStreamEvent);
  }
  const aggregateResult = computeAggregateEvents({
    curr: result.curr,
    parsed: resolved.parsed,
    epicRepo: resolved.epic.repo,
    epicNumber: resolved.epic.number,
    prevState: state.aggState,
    initial: state.firstPoll,
    now: () => new Date().toISOString(),
  });
  for (const event of aggregateResult.events) {
    bus.emit(event as CockpitStreamEvent);
  }
  state.aggState = aggregateResult.nextState;
  state.prev = result.curr;
  state.firstPoll = false;

  // Refresh the resolved epic only every Nth cycle (best effort). Skip the
  // cycle that already fetched a fresh epic — otherwise we would refresh on
  // cycles 10, 20, 30 instead of the intended 11, 21, 31 cadence.
  if (!justFetched) {
    state.cyclesSinceEpicRefresh += 1;
    if (state.cyclesSinceEpicRefresh >= EPIC_REFRESH_CYCLES) {
      state.cyclesSinceEpicRefresh = 0;
      try {
        state.currentResolved = await resolveEpic({ epicRef: expandedRef, gh, logger });
      } catch (err) {
        logger.warn(
          `event-bus: resolveEpic refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

/**
 * Test-only: forcibly release all subscriptions. Use in test `afterEach`.
 */
export function _resetRegistryForTests(): void {
  for (const sub of registry.values()) {
    if (sub.idleTimer != null) clearTimeout(sub.idleTimer);
    sub.stop();
  }
  registry.clear();
}
