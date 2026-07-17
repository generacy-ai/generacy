/**
 * `generacy cockpit doorbell` — wake sensor for `/cockpit:auto`.
 *
 * Owns its own in-process `acquireEpicBus()` call (Q1=C rationale: the
 * cockpit MCP server is stdio-only and cannot accept a second client). One
 * process → one bus → one poll loop → one stdout line per event.
 *
 * Contract: `contracts/cli-surface.md`, `data-model.md`.
 */
import { Command } from 'commander';
import {
  GhCliWrapper,
  createGhResponseCache,
  createRateLimitScheduler,
  nodeChildProcessRunner,
  type CommandRunner,
  type GhWrapper,
  type RateLimitScheduler,
} from '@generacy-ai/cockpit';
import {
  acquireEpicBus,
  type AcquireOptions,
  type Acquired,
} from './mcp/event-bus-registry.js';
import { subscribeAndEmit } from './doorbell/subscribe.js';
import type { CockpitStreamEvent } from './watch/stream-event.js';

export interface DoorbellOptions {
  tracking?: boolean;
  new?: string;
  exitOnEpicComplete?: boolean;
}

export interface DoorbellDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
  rateLimitScheduler?: RateLimitScheduler;
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
  acquireBus?: (options: AcquireOptions) => Promise<Acquired>;
  abortSignal?: AbortSignal;
  stdout?: { write(chunk: string, cb?: () => void): boolean | void };
  exit?: (code: number) => void;
}

export type Form =
  | { kind: 'form-1'; ref: string }
  | { kind: 'form-2'; ref: string }
  | { kind: 'form-3'; title: string };

export type Rejection =
  | { kind: 'missing-positional' }
  | { kind: 'conflicting-flags'; reason: 'positional-with-new' | 'tracking-with-new' };

export function classifyForm(
  positional: string | undefined,
  options: DoorbellOptions,
): Form | Rejection {
  const hasPositional = positional != null && positional.trim() !== '';
  const hasTracking = options.tracking === true;
  const hasNew = options.new != null && options.new.trim() !== '';

  if (hasTracking && hasNew) {
    return { kind: 'conflicting-flags', reason: 'tracking-with-new' };
  }
  if (hasNew) {
    if (hasPositional) {
      return { kind: 'conflicting-flags', reason: 'positional-with-new' };
    }
    return { kind: 'form-3', title: options.new! };
  }
  if (!hasPositional) {
    return { kind: 'missing-positional' };
  }
  if (hasTracking) {
    return { kind: 'form-2', ref: positional! };
  }
  return { kind: 'form-1', ref: positional! };
}

function drainStdout(
  stdout: { write(chunk: string, cb?: () => void): boolean | void },
): Promise<void> {
  return new Promise<void>((resolve) => {
    stdout.write('', () => resolve());
  });
}

function writeLine(
  stdout: { write(chunk: string, cb?: () => void): boolean | void },
  line: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    stdout.write(line, () => resolve());
  });
}

export async function runDoorbell(
  positional: string | undefined,
  options: DoorbellOptions,
  deps: DoorbellDeps = {},
): Promise<number> {
  const stderr = process.stderr;
  const stdout = deps.stdout ?? process.stdout;
  const exit =
    deps.exit ??
    ((code: number) => {
      process.exit(code);
    });

  const form = classifyForm(positional, options);
  if (form.kind === 'missing-positional') {
    stderr.write('cockpit doorbell: parse issue: issue argument is required\n');
    try {
      exit(2);
    } catch {
      /* test seam may throw; propagate return */
    }
    return 2;
  }
  if (form.kind === 'conflicting-flags') {
    if (form.reason === 'positional-with-new') {
      stderr.write('cockpit doorbell: --new does not accept a positional argument\n');
    } else {
      stderr.write('cockpit doorbell: --tracking and --new are mutually exclusive\n');
    }
    try {
      exit(2);
    } catch {
      /* test seam may throw; propagate return */
    }
    return 2;
  }

  const logger =
    deps.logger ?? { warn: (msg: string) => process.stderr.write(`${msg}\n`) };

  let stopResolve: () => void = () => undefined;
  const stopPromise = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    stopResolve();
  };

  const onSignal = (): void => {
    stop();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const cleanupSignals = (): void => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
  if (deps.abortSignal != null) {
    if (deps.abortSignal.aborted) {
      stop();
    } else {
      deps.abortSignal.addEventListener('abort', onSignal, { once: true });
    }
  }

  if (form.kind === 'form-3') {
    await writeLine(stdout, 'armed\n');
    await stopPromise;
    await drainStdout(stdout);
    cleanupSignals();
    try {
      exit(0);
    } catch {
      /* test seam may throw */
    }
    return 0;
  }

  const acquire = deps.acquireBus ?? acquireEpicBus;
  let acquired: Acquired;
  try {
    const acquireOptions: AcquireOptions = {
      epicRef: form.ref,
      logger,
    };
    if (deps.runner != null) acquireOptions.runner = deps.runner;
    if (deps.gh != null) acquireOptions.gh = deps.gh;
    if (deps.rateLimitScheduler != null) {
      acquireOptions.rateLimitScheduler = deps.rateLimitScheduler;
    }
    acquired = await acquire(acquireOptions);
  } catch (err) {
    stderr.write(
      `cockpit doorbell: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    cleanupSignals();
    try {
      exit(2);
    } catch {
      /* test seam may throw */
    }
    return 2;
  }
  const release: () => void = acquired.release;

  await writeLine(stdout, 'armed\n');

  const onEmit = (event: CockpitStreamEvent): void => {
    if (
      options.exitOnEpicComplete === true &&
      form.kind === 'form-1' &&
      event.type === 'epic-complete'
    ) {
      stop();
    }
  };

  const unsubscribe = subscribeAndEmit(acquired.bus, { stdout, onEmit });

  await stopPromise;

  unsubscribe();
  release();
  await drainStdout(stdout);
  cleanupSignals();
  try {
    exit(0);
  } catch {
    /* test seam may throw */
  }
  return 0;
}

export function doorbellCommand(): Command {
  return new Command('doorbell')
    .description(
      'Wake sensor for /cockpit:auto. Emits one stdout line per epic bus event.',
    )
    .argument(
      '[epic-ref]',
      'Epic ref (Form 1) or tracking-issue ref (Form 2). Omitted under --new.',
    )
    .option(
      '--tracking',
      'Positional is a tracking-issue ref; subscribe the tracking-ref bus.',
      false,
    )
    .option(
      '--new <title>',
      'No subscription; arm as a placeholder before the tracking issue exists.',
    )
    .option(
      '--exit-on-epic-complete',
      'Exit 0 after flushing the epic-complete line. Off by default.',
      false,
    )
    .action(async (epicRef: string | undefined, options: DoorbellOptions) => {
      const runner: CommandRunner = nodeChildProcessRunner;
      const cache = createGhResponseCache();
      const rateLimitScheduler = createRateLimitScheduler({ runner });
      const gh = new GhCliWrapper(runner, undefined, { cache, rateLimitScheduler });
      const code = await runDoorbell(epicRef, options, {
        runner,
        gh,
        rateLimitScheduler,
      });
      process.exit(code);
    });
}
