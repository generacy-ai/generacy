/**
 * Per-orchestrator-process registry of `EpicEventBus` instances, keyed by
 * epic-ref string (`"owner/repo#number"`).
 *
 * Each bus is driven by a private poller — mirrors `watch.ts` but emits into
 * the bus instead of stdout NDJSON. Multiple concurrent `cockpit_await_events`
 * callers against the same epic share the subscriber; refcounted via
 * `acquire` / `release`.
 */
import {
  GhCliWrapper,
  LoudResolverError,
  resolveEpic,
  type CommandRunner,
  type GhWrapper,
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

interface Subscription {
  bus: EpicEventBus;
  refCount: number;
  stop: () => void;
}

const registry = new Map<string, Subscription>();

export interface AcquireOptions {
  epicRef: string;
  runner?: CommandRunner;
  gh?: GhWrapper;
  intervalMs?: number;
  logger?: { warn: (msg: string) => void };
  /**
   * Injection seam for tests: build an event bus without starting a poll
   * loop. Callers use the returned bus's `emit()` directly.
   */
  noPoll?: boolean;
}

export interface Acquired {
  bus: EpicEventBus;
  release: () => void;
}

export async function acquireEpicBus(options: AcquireOptions): Promise<Acquired> {
  const expandedRef = await expandRef(options.epicRef, options.runner);
  const existing = registry.get(expandedRef);
  if (existing != null) {
    existing.refCount += 1;
    return { bus: existing.bus, release: () => releaseKey(expandedRef) };
  }

  const bus = new EpicEventBus({ epic: expandedRef });

  if (options.noPoll === true) {
    const sub: Subscription = { bus, refCount: 1, stop: () => undefined };
    registry.set(expandedRef, sub);
    return { bus, release: () => releaseKey(expandedRef) };
  }

  const logger = options.logger ?? { warn: () => undefined };
  const gh = options.gh ?? new GhCliWrapper(options.runner);
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  const controller = new AbortController();
  const stop = (): void => controller.abort();

  void runPollLoop(bus, expandedRef, gh, interval, controller.signal, logger);

  const sub: Subscription = { bus, refCount: 1, stop };
  registry.set(expandedRef, sub);
  return { bus, release: () => releaseKey(expandedRef) };
}

function releaseKey(key: string): void {
  const sub = registry.get(key);
  if (sub == null) return;
  sub.refCount -= 1;
  if (sub.refCount <= 0) {
    sub.stop();
    registry.delete(key);
  }
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

async function runPollLoop(
  bus: EpicEventBus,
  expandedRef: string,
  gh: GhWrapper,
  interval: number,
  signal: AbortSignal,
  logger: { warn: (msg: string) => void },
): Promise<void> {
  let prev: SnapshotMap = new Map();
  let aggState: AggregateState = initialAggregateState();
  let firstPoll = true;
  let currentResolved: ResolvedEpic;

  try {
    currentResolved = await resolveEpic({ epicRef: expandedRef, gh, logger });
  } catch (err) {
    if (err instanceof LoudResolverError) {
      logger.warn(`event-bus: initial resolveEpic failed: ${err.message}`);
      return;
    }
    logger.warn(`event-bus: initial resolveEpic failed: ${String(err)}`);
    return;
  }

  while (!signal.aborted) {
    try {
      const result = await runOnePoll(prev, {
        gh,
        refs: currentResolved.parsed.allRefs,
        epicOwnerRepo: currentResolved.epic.repo,
        logger,
      });
      for (const event of result.events) {
        // event is a CockpitEvent from diff.ts; matches the CockpitEventSchema
        // shape emit() writes to NDJSON.
        bus.emit({ ...event, type: 'issue-transition' } as CockpitStreamEvent);
      }
      const aggregateResult = computeAggregateEvents({
        curr: result.curr,
        parsed: currentResolved.parsed,
        epicRepo: currentResolved.epic.repo,
        epicNumber: currentResolved.epic.number,
        prevState: aggState,
        initial: firstPoll,
        now: () => new Date().toISOString(),
      });
      for (const event of aggregateResult.events) {
        bus.emit(event as CockpitStreamEvent);
      }
      aggState = aggregateResult.nextState;
      prev = result.curr;
      firstPoll = false;
    } catch (err) {
      logger.warn(`event-bus: poll error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (signal.aborted) break;
    await sleep(interval, signal);
    if (signal.aborted) break;

    try {
      currentResolved = await resolveEpic({ epicRef: expandedRef, gh, logger });
    } catch (err) {
      logger.warn(`event-bus: resolveEpic failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Test-only: forcibly release all subscriptions. Use in test `afterEach`.
 */
export function _resetRegistryForTests(): void {
  for (const sub of registry.values()) sub.stop();
  registry.clear();
}
