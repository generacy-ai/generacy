/**
 * `generacy cockpit doorbell` — wake sensor for `/cockpit:auto`.
 *
 * Owns its own in-process `acquireEpicBus()` call (Q1=C rationale: the
 * cockpit MCP server is stdio-only and cannot accept a second client). On
 * smee-live clusters, the doorbell subscribes to the smee.io SSE stream
 * (real-time-first — revised FR-011, #978) with the poll bus as fallback.
 * One process → one wake source at a time → one stdout line per event.
 *
 * Contract: `contracts/cli-surface.md`, `data-model.md`.
 */
import { promises as fsPromises } from 'node:fs';
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
import { subscribeAndEmit, lineForEvent } from './doorbell/subscribe.js';
import type { CockpitStreamEvent } from './watch/stream-event.js';
import {
  discoverChannelUrl,
  DEFAULT_CHANNEL_FILE_PATH,
  type ChannelDiscoveryResult,
} from './doorbell/channel-discovery.js';
import { resolveWebhookTargets } from './doorbell/webhook-target-resolver.js';
import { SourceSelector, type SourceMode } from './doorbell/source-selector.js';
import { SmeeDoorbellSource } from './doorbell/smee-source.js';
import { runStartupRetry } from './doorbell/startup-retry.js';
import { AnswersFileSource } from './doorbell/answers-file-source.js';
import type { GateAnswerEvent } from './watch/gate-answer.js';

export interface DoorbellOptions {
  tracking?: boolean;
  new?: string;
  exitOnEpicComplete?: boolean;
}

export interface DoorbellDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
  rateLimitScheduler?: RateLimitScheduler;
  logger?: { warn: (msg: string) => void; info: (msg: string) => void };
  acquireBus?: (options: AcquireOptions) => Promise<Acquired>;
  abortSignal?: AbortSignal;
  stdout?: { write(chunk: string, cb?: () => void): boolean | void };
  exit?: (code: number) => void;
  /** Test seam: override channel discovery. */
  discoverChannel?: typeof discoverChannelUrl;
  /** Test seam: override the smee source constructor. */
  smeeSourceFactory?: (opts: ConstructorParameters<typeof SmeeDoorbellSource>[0]) => SmeeDoorbellSource;
  /** Test seam: override the source selector constructor. */
  sourceSelectorFactory?: (opts: ConstructorParameters<typeof SourceSelector>[0]) => SourceSelector;
  /** Test seam: override the answers-file tailer constructor. */
  answersFileSourceFactory?: (
    opts: ConstructorParameters<typeof AnswersFileSource>[0],
  ) => AnswersFileSource;
  /** Test seam: override the answers-file path. */
  answersFilePath?: string;
  /** Test seam: env passed to `discoverChannelUrl`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: filesystem passed to `discoverChannelUrl`. */
  fs?: Parameters<typeof discoverChannelUrl>[0]['fs'];
  /** Test seam: channel-file path override. */
  channelFilePath?: string;
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

interface RunPollModeInput {
  ref: string;
  form: Form & { kind: 'form-1' | 'form-2' };
  options: DoorbellOptions;
  deps: DoorbellDeps;
  logger: { warn: (msg: string) => void; info: (msg: string) => void };
  stdout: { write(chunk: string, cb?: () => void): boolean | void };
  stderr: { write(chunk: string): boolean | void };
  stopPromise: Promise<void>;
  stop: () => void;
  retryAbortSignal: AbortSignal;
}

interface RunPollModeHandle {
  release: () => void;
  waitForStop: () => Promise<void>;
}

/**
 * Fallback scheduler for tests / callers that do not wire a real
 * rate-limit-aware scheduler. Retry envelope treats absence as "sleep for
 * 1s between attempts and do nothing else".
 */
function noopScheduler(): RateLimitScheduler {
  return {
    getCurrentIntervalMs: () => 1_000,
    probeNow: async () => null,
    noteRetryAfter: () => undefined,
    noteResponseHeaders: () => undefined,
    start: () => undefined,
    stop: () => undefined,
  };
}

async function runPollMode(
  input: RunPollModeInput,
): Promise<RunPollModeHandle | { kind: 'permanent-exit' } | null> {
  const acquire = input.deps.acquireBus ?? acquireEpicBus;
  const acquireOptions: AcquireOptions = {
    epicRef: input.ref,
    logger: input.logger,
  };
  if (input.deps.runner != null) acquireOptions.runner = input.deps.runner;
  if (input.deps.gh != null) acquireOptions.gh = input.deps.gh;
  if (input.deps.rateLimitScheduler != null) {
    acquireOptions.rateLimitScheduler = input.deps.rateLimitScheduler;
  }

  const outcome = await runStartupRetry<Acquired>({
    task: () => acquire(acquireOptions),
    label: 'acquireEpicBus',
    rateLimitScheduler: input.deps.rateLimitScheduler ?? noopScheduler(),
    abortSignal: input.retryAbortSignal,
    stderr: input.stderr,
    logger: input.logger,
  });
  if (outcome.kind === 'permanent') {
    return { kind: 'permanent-exit' };
  }
  if (outcome.kind === 'aborted') {
    return null;
  }
  const acquired = outcome.value;

  const onEmit = (event: CockpitStreamEvent): void => {
    if (
      input.options.exitOnEpicComplete === true &&
      input.form.kind === 'form-1' &&
      event.type === 'epic-complete'
    ) {
      input.stop();
    }
  };

  const unsubscribe = subscribeAndEmit(acquired.bus, {
    stdout: input.stdout,
    onEmit,
    skipTypes: ['gate-answer'],
  });

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    unsubscribe();
    acquired.release();
  };

  return {
    release,
    waitForStop: () => input.stopPromise,
  };
}

interface RunSmeeModeInput {
  ref: string;
  form: Form & { kind: 'form-1' | 'form-2' };
  channelUrl: string;
  options: DoorbellOptions;
  deps: DoorbellDeps;
  logger: { warn: (msg: string) => void; info: (msg: string) => void };
  stdout: { write(chunk: string, cb?: () => void): boolean | void };
  selector: SourceSelector;
  stop: () => void;
  retryAbortSignal: AbortSignal;
}

interface RunSmeeModeHandle {
  source: SmeeDoorbellSource;
}

async function runSmeeMode(
  input: RunSmeeModeInput,
): Promise<RunSmeeModeHandle | { kind: 'permanent-exit' } | null> {
  if (input.deps.gh == null) {
    input.logger.warn('cockpit doorbell: smee-mode requires a gh wrapper; falling through');
    return null;
  }
  const gh = input.deps.gh;

  const onEvent = async (event: CockpitStreamEvent): Promise<void> => {
    await new Promise<void>((resolve) => {
      input.stdout.write(lineForEvent(event), () => resolve());
    });
    if (
      input.options.exitOnEpicComplete === true &&
      input.form.kind === 'form-1' &&
      event.type === 'epic-complete'
    ) {
      input.stop();
    }
  };

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
  if (input.deps.runner != null) sourceOptions.runner = input.deps.runner;

  const source =
    input.deps.smeeSourceFactory != null
      ? input.deps.smeeSourceFactory(sourceOptions)
      : new SmeeDoorbellSource(sourceOptions);

  const outcome = await runStartupRetry<null>({
    task: async () => {
      await source.start();
      return null;
    },
    label: 'resolveEpic',
    rateLimitScheduler: input.deps.rateLimitScheduler ?? noopScheduler(),
    abortSignal: input.retryAbortSignal,
    stderr: process.stderr,
    logger: input.logger,
  });
  if (outcome.kind === 'permanent') {
    return { kind: 'permanent-exit' };
  }
  if (outcome.kind === 'aborted') {
    return null;
  }

  return { source };
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

  const logger = deps.logger ?? {
    warn: (msg: string) => process.stderr.write(`${msg}\n`),
    info: (msg: string) => process.stderr.write(`${msg}\n`),
  };

  let stopResolve: () => void = () => undefined;
  const stopPromise = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });
  let stopped = false;
  // Signal used to abort startup-retry sleeps promptly on shutdown.
  const retryAbortController = new AbortController();
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    retryAbortController.abort();
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

  // `armed\n` written before source selection (Q5=A / spec-explicit
  // "unconditional, before source selection"). Preserves the shipped
  // contract with agency#431 — the FR-006 `source=…` line on stderr is the
  // "which source settled" signal.
  await writeLine(stdout, 'armed\n');

  if (form.kind === 'form-3') {
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

  // Answers-file tailer — peer wake source that runs concurrently with
  // whichever primary source `source-selector` picks. Bound to the same
  // epicRef as the doorbell; writes gate-answer events to stdout and emits
  // them into a shared bus so `cockpit_await_events` sees them too. Wrapped
  // in the same startup-retry envelope as poll-mode acquire so transient
  // ECONNRESET / rate-limit responses are retried consistently.
  const acquireForTailer = deps.acquireBus ?? acquireEpicBus;
  const tailerAcquireOptions: AcquireOptions = {
    epicRef: form.ref,
    logger,
  };
  if (deps.runner != null) tailerAcquireOptions.runner = deps.runner;
  if (deps.gh != null) tailerAcquireOptions.gh = deps.gh;
  if (deps.rateLimitScheduler != null) {
    tailerAcquireOptions.rateLimitScheduler = deps.rateLimitScheduler;
  }
  let answersTailer: AnswersFileSource | null = null;
  let answersBusHandle: Acquired | null = null;
  const tailerAcquireOutcome = await runStartupRetry<Acquired>({
    task: () => acquireForTailer(tailerAcquireOptions),
    label: 'acquireEpicBus',
    rateLimitScheduler: deps.rateLimitScheduler ?? noopScheduler(),
    abortSignal: retryAbortController.signal,
    stderr,
    logger,
  });
  if (tailerAcquireOutcome.kind === 'success') {
    answersBusHandle = tailerAcquireOutcome.value;
  } else if (tailerAcquireOutcome.kind === 'permanent') {
    logger.warn(
      'cockpit doorbell: answers tailer disabled — bus acquire hit permanent error',
    );
  }
  if (answersBusHandle != null) {
    const busForTailer = answersBusHandle.bus;
    const answersOnEvent = async (event: GateAnswerEvent): Promise<void> => {
      await new Promise<void>((resolve) => {
        stdout.write(lineForEvent(event), () => resolve());
      });
      busForTailer.emit(event);
    };
    const tailerOptions: ConstructorParameters<typeof AnswersFileSource>[0] = {
      epicRef: form.ref,
      onEvent: answersOnEvent,
      logger,
    };
    if (deps.answersFilePath != null) tailerOptions.filePath = deps.answersFilePath;
    answersTailer =
      deps.answersFileSourceFactory != null
        ? deps.answersFileSourceFactory(tailerOptions)
        : new AnswersFileSource(tailerOptions);
    // Fire-and-forget start — replay drains concurrently with source setup.
    void answersTailer.start().catch((err) => {
      logger.warn(
        `cockpit doorbell: answers tailer start failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  const discover = deps.discoverChannel ?? discoverChannelUrl;
  const env = deps.env ?? process.env;
  const fs = deps.fs ?? fsPromises;
  const channelFilePath = deps.channelFilePath ?? DEFAULT_CHANNEL_FILE_PATH;
  // Smee-mode needs a gh wrapper for ref-set resolution and aggregate refreshes.
  // Without one, discovery is wasted work and the code must poll-fallback anyway.
  let discovery: ChannelDiscoveryResult | null = null;
  if (deps.gh != null || deps.discoverChannel != null) {
    let targets: Array<{ owner: string; repo: string }> = [];
    if (deps.gh != null) {
      try {
        targets = await resolveWebhookTargets({
          epicRef: form.ref,
          gh: deps.gh,
          logger,
        });
      } catch {
        targets = [];
      }
    }
    const discoveryInput: Parameters<typeof discoverChannelUrl>[0] = {
      env,
      channelFilePath,
      fs,
      logger,
      targets,
      runner: deps.runner ?? nodeChildProcessRunner,
    };
    try {
      discovery = await discover(discoveryInput);
    } catch {
      discovery = null;
    }
  }

  const selectorOptions: ConstructorParameters<typeof SourceSelector>[0] = {
    initial: discovery == null ? 'poll-fallback' : 'smee-attempt',
    stderr,
    logger,
  };
  const selector =
    deps.sourceSelectorFactory != null
      ? deps.sourceSelectorFactory(selectorOptions)
      : new SourceSelector(selectorOptions);

  let pollHandle: RunPollModeHandle | null = null;
  let smeeHandle: RunSmeeModeHandle | null = null;

  const tearDownActiveSource = async (): Promise<void> => {
    if (smeeHandle != null) {
      const s = smeeHandle;
      smeeHandle = null;
      await s.source.stop();
    }
    if (pollHandle != null) {
      const p = pollHandle;
      pollHandle = null;
      p.release();
    }
  };

  const tearDownAnswersTailer = async (): Promise<void> => {
    if (answersTailer != null) {
      const t = answersTailer;
      answersTailer = null;
      try {
        await t.stop();
      } catch {
        /* best-effort */
      }
    }
    if (answersBusHandle != null) {
      const h = answersBusHandle;
      answersBusHandle = null;
      try {
        h.release();
      } catch {
        /* best-effort */
      }
    }
  };

  type StartOutcome = 'ok' | 'transient-fail' | 'permanent-exit';

  // In-flight guard: the startup fall-through calls markStartupSmeeFailed()
  // (which synchronously fires the poll-fallback callback → fire-and-forget
  // startPollMode) and then also awaits startPollMode() directly. Without
  // this guard both would pass the `pollHandle != null` check and create
  // two subscribers on the same bus.
  let pollStartInFlight: Promise<StartOutcome> | null = null;
  const startPollMode = async (): Promise<StartOutcome> => {
    if (pollHandle != null) return 'ok';
    if (pollStartInFlight != null) return pollStartInFlight;
    pollStartInFlight = (async (): Promise<StartOutcome> => {
      try {
        const handle = await runPollMode({
          ref: form.ref,
          form,
          options,
          deps,
          logger,
          stdout,
          stderr,
          stopPromise,
          stop,
          retryAbortSignal: retryAbortController.signal,
        });
        if (handle == null) return 'transient-fail';
        if ('kind' in handle && handle.kind === 'permanent-exit') return 'permanent-exit';
        pollHandle = handle as RunPollModeHandle;
        return 'ok';
      } finally {
        pollStartInFlight = null;
      }
    })();
    return pollStartInFlight;
  };

  const startSmeeMode = async (url: string): Promise<StartOutcome> => {
    if (smeeHandle != null) return 'ok';
    const handle = await runSmeeMode({
      ref: form.ref,
      form,
      channelUrl: url,
      options,
      deps,
      logger,
      stdout,
      selector,
      stop,
      retryAbortSignal: retryAbortController.signal,
    });
    if (handle == null) return 'transient-fail';
    if ('kind' in handle && handle.kind === 'permanent-exit') return 'permanent-exit';
    smeeHandle = handle as RunSmeeModeHandle;
    return 'ok';
  };

  // Signals a permanent-error exit from a mode-change branch that runs
  // fire-and-forget. Consumed once at the outer boundary.
  let permanentExit = false;

  selector.onModeChange((next: SourceMode) => {
    if (next === 'poll-fallback') {
      // Live bridge: keep smeeHandle alive so its runLoop keeps reconnecting
      // in the background; open a poll subscriber alongside so stdout stays
      // hot. Never stop the smee source here.
      void (async (): Promise<void> => {
        const outcome = await startPollMode();
        if (outcome === 'permanent-exit') {
          permanentExit = true;
          stop();
        } else if (outcome === 'transient-fail') stop();
      })();
    } else if (next === 'smee-active') {
      // Runtime bridge exit: background smee reconnected. Release the poll
      // subscriber; smee source is already streaming.
      if (pollHandle != null) {
        const p = pollHandle;
        pollHandle = null;
        p.release();
      }
    } else if (next === 'smee-attempt' && discovery != null) {
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
          // smee-attempt failed → fall back to poll-mode immediately, without
          // waiting for the demotion counter.
          const pollOutcome = await startPollMode();
          if (pollOutcome === 'permanent-exit') {
            permanentExit = true;
            stop();
          } else if (pollOutcome === 'transient-fail') stop();
        }
      })();
    }
  });

  if (discovery != null) {
    const outcome = await startSmeeMode(discovery.url);
    if (outcome === 'permanent-exit') {
      await tearDownAnswersTailer();
      selector.stop();
      cleanupSignals();
      try {
        exit(3);
      } catch {
        /* test seam may throw */
      }
      return 3;
    }
    if (outcome === 'transient-fail') {
      selector.markStartupSmeeFailed();
      const pollOutcome = await startPollMode();
      if (pollOutcome === 'permanent-exit') {
        selector.stop();
        cleanupSignals();
        try {
          exit(3);
        } catch {
          /* test seam may throw */
        }
        return 3;
      }
      if (pollOutcome === 'transient-fail' && !stopped) {
        await tearDownAnswersTailer();
        selector.stop();
        cleanupSignals();
        try {
          exit(2);
        } catch {
          /* test seam may throw */
        }
        return 2;
      }
    }
  } else {
    const outcome = await startPollMode();
    if (outcome === 'permanent-exit') {
      await tearDownAnswersTailer();
      selector.stop();
      cleanupSignals();
      try {
        exit(3);
      } catch {
        /* test seam may throw */
      }
      return 3;
    }
    if (outcome === 'transient-fail' && !stopped) {
      await tearDownAnswersTailer();
      selector.stop();
      cleanupSignals();
      try {
        exit(2);
      } catch {
        /* test seam may throw */
      }
      return 2;
    }
  }

  await stopPromise;

  await tearDownActiveSource();
  await tearDownAnswersTailer();
  selector.stop();
  await drainStdout(stdout);
  cleanupSignals();
  const finalCode = permanentExit ? 3 : 0;
  try {
    exit(finalCode);
  } catch {
    /* test seam may throw */
  }
  return finalCode;
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
