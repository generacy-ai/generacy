import { Command } from 'commander';
import {
  GhCliWrapper,
  LoudResolverError,
  resolveEpic,
  type CommandRunner,
  type GhWrapper,
  type ResolvedEpic,
} from '@generacy-ai/cockpit';
import { resolveIssueContext } from './resolver.js';
import { runOnePoll } from './watch/poll-loop.js';
import { emit } from './watch/emit.js';
import { emitAggregate } from './watch/aggregate-emit.js';
import {
  computeAggregateEvents,
  initialAggregateState,
  type AggregateState,
} from './watch/aggregate.js';
import type { SnapshotMap } from './watch/snapshot.js';

interface WatchOptions {
  interval?: string;
  safetyCap?: string;
  exitOnEpicComplete?: boolean;
}

const DEFAULT_INTERVAL_MS = 30_000;
const INTERVAL_FLOOR_MS = 15_000;
const DEFAULT_SAFETY_CAP = 1000;

function parseIntFlag(name: string, raw: string | undefined, min: number, defaultValue: number): number {
  if (raw == null) return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`--${name} must be an integer >= ${min}`);
  }
  return n;
}

function parseIntervalFlag(raw: string | undefined): number {
  if (raw == null) return DEFAULT_INTERVAL_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('--interval must be a positive integer (milliseconds)');
  }
  if (n < INTERVAL_FLOOR_MS) {
    process.stderr.write(
      `cockpit watch: --interval ${n} below floor ${INTERVAL_FLOOR_MS}ms; clamping.\n`,
    );
    return INTERVAL_FLOOR_MS;
  }
  return n;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    // Do not unref — see #836. An embedder that needs an unref'd timer must gate
    // it behind an explicit WatchDeps flag the CLI never sets.
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export interface WatchDeps {
  gh?: GhWrapper;
  runner?: CommandRunner;
  logger?: { warn: (msg: string) => void };
  intervalOverride?: number;
  onTick?: () => void;
  /** Optional external abort — used by tests to stop the loop deterministically. */
  abortSignal?: AbortSignal;
}

export async function runWatch(
  epicRef: string | undefined,
  options: WatchOptions,
  deps: WatchDeps = {},
): Promise<number> {
  if (epicRef == null || epicRef.trim() === '') {
    process.stderr.write('cockpit watch: parse issue: issue argument is required\n');
    return 2;
  }

  let interval: number;
  let safetyCap: number;
  try {
    interval = deps.intervalOverride ?? parseIntervalFlag(options.interval);
    safetyCap = parseIntFlag('safety-cap', options.safetyCap, 1, DEFAULT_SAFETY_CAP);
  } catch (err) {
    process.stderr.write(`cockpit watch: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const logger = deps.logger ?? { warn: (msg: string) => process.stderr.write(`${msg}\n`) };

  let expandedRef: string;
  let gh: GhWrapper;
  try {
    const resolvedCtx = await resolveIssueContext({ issue: epicRef, runner: deps.runner });
    expandedRef = `${resolvedCtx.ref.nwo}#${resolvedCtx.ref.number}`;
    gh = deps.gh ?? resolvedCtx.gh;
  } catch (err) {
    process.stderr.write(`cockpit watch: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  let initialResolved: ResolvedEpic;
  try {
    initialResolved = await resolveEpic({ epicRef: expandedRef, gh, logger });
  } catch (err) {
    process.stderr.write(`cockpit watch: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof LoudResolverError && err.code === 'INVALID_EPIC_REF') {
      return 2;
    }
    return 1;
  }

  process.stderr.write(
    `cockpit watch: epic ${initialResolved.epic.repo}#${initialResolved.epic.number}; repos [${initialResolved.repos.join(', ')}]; interval=${interval}ms\n`,
  );

  for (const phase of initialResolved.parsed.phases) {
    if (phase.refs.length === 0) {
      process.stderr.write(
        `cockpit watch: phase "${phase.heading}" has no issue refs; treated as complete\n`,
      );
    }
  }

  const controller = new AbortController();
  let stopped = false;
  const onStop = (): void => {
    stopped = true;
    controller.abort();
  };
  process.once('SIGINT', onStop);
  process.once('SIGTERM', onStop);
  if (deps.abortSignal != null) {
    if (deps.abortSignal.aborted) {
      onStop();
    } else {
      deps.abortSignal.addEventListener('abort', onStop, { once: true });
    }
  }

  let prev: SnapshotMap = new Map();
  let firstTick = true;
  let firstPoll = true;
  let aggState: AggregateState = initialAggregateState();
  let currentResolved: ResolvedEpic = initialResolved;

  while (!stopped) {
    if (!firstTick) {
      try {
        currentResolved = await resolveEpic({ epicRef: expandedRef, gh, logger });
      } catch (err) {
        process.stderr.write(
          `cockpit watch: poll error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        deps.onTick?.();
        if (stopped) break;
        await sleep(interval, controller.signal);
        continue;
      }
    }
    firstTick = false;

    try {
      const result = await runOnePoll(prev, {
        gh,
        refs: currentResolved.parsed.allRefs,
        epicOwnerRepo: currentResolved.epic.repo,
        safetyCap,
        logger,
      });
      for (const event of result.events) {
        emit(event);
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
        emitAggregate(event);
      }
      aggState = aggregateResult.nextState;
      prev = result.curr;
      firstPoll = false;

      if (options.exitOnEpicComplete === true) {
        const emittedEpicComplete = aggregateResult.events.some(
          (e) => e.type === 'epic-complete',
        );
        if (emittedEpicComplete) {
          await new Promise<void>((resolve) => {
            process.stdout.write('', () => resolve());
          });
          process.exit(0);
        }
      }
    } catch (err) {
      process.stderr.write(
        `cockpit watch: poll error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    deps.onTick?.();
    if (stopped) break;
    await sleep(interval, controller.signal);
  }

  return 0;
}

export function watchCommand(): Command {
  return new Command('watch')
    .description('Emit one NDJSON line per issue/PR state transition. Pure sensor.')
    .argument(
      '<epic-ref>',
      'Epic ref. Accepts <n>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.',
    )
    .option('--interval <ms>', `Poll interval in ms (default ${DEFAULT_INTERVAL_MS}, floor ${INTERVAL_FLOOR_MS}).`)
    .option('--safety-cap <n>', `Warn when per-poll item count exceeds this (default ${DEFAULT_SAFETY_CAP}).`)
    .option('--exit-on-epic-complete', 'Exit 0 after flushing the epic-complete NDJSON line.', false)
    .action(async (epicRef: string, options: WatchOptions) => {
      const code = await runWatch(epicRef, options);
      process.exit(code);
    });
}
