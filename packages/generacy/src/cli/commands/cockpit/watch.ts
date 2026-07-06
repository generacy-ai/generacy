import { Command } from 'commander';
import {
  GhCliWrapper,
  LoudResolverError,
  resolveEpic,
  type GhWrapper,
  type ResolvedEpic,
} from '@generacy-ai/cockpit';
import { runOnePoll } from './watch/poll-loop.js';
import { emit } from './watch/emit.js';
import type { SnapshotMap } from './watch/snapshot.js';

interface WatchOptions {
  epic?: string;
  interval?: string;
  safetyCap?: string;
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
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export interface WatchDeps {
  gh?: GhWrapper;
  logger?: { warn: (msg: string) => void };
  intervalOverride?: number;
  onTick?: () => void;
  /** Optional external abort — used by tests to stop the loop deterministically. */
  abortSignal?: AbortSignal;
}

export async function runWatch(
  options: WatchOptions,
  deps: WatchDeps = {},
): Promise<number> {
  if (options.epic == null || options.epic.trim() === '') {
    process.stderr.write('cockpit watch: --epic is required (format owner/repo#N)\n');
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

  const gh = deps.gh ?? new GhCliWrapper();
  const logger = deps.logger ?? { warn: (msg: string) => process.stderr.write(`${msg}\n`) };

  let initialResolved: ResolvedEpic;
  try {
    initialResolved = await resolveEpic({ epicRef: options.epic, gh, logger });
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
  let currentResolved: ResolvedEpic = initialResolved;

  while (!stopped) {
    if (!firstTick) {
      try {
        currentResolved = await resolveEpic({ epicRef: options.epic, gh, logger });
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
      prev = result.curr;
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
    .requiredOption('--epic <ownerRepoIssue>', 'Scope to a single epic. Format owner/repo#N.')
    .option('--interval <ms>', `Poll interval in ms (default ${DEFAULT_INTERVAL_MS}, floor ${INTERVAL_FLOOR_MS}).`)
    .option('--safety-cap <n>', `Warn when per-poll item count exceeds this (default ${DEFAULT_SAFETY_CAP}).`)
    .action(async (options: WatchOptions) => {
      const code = await runWatch(options);
      process.exit(code);
    });
}
