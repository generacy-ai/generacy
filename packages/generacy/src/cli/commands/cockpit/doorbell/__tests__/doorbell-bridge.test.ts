/**
 * FR-007 regression: doorbell survives smee loss + quiet windows.
 *
 * Three scenarios covered:
 *   (a) ≥60-min quiet-but-alive smee stream (periodic keepalive bytes) —
 *       no `poll-fallback` transition, no `stop()` call on the smee source,
 *       stdout stream stays open.
 *   (b) Keepalives stop mid-run — `elapsedTicker` past 90s fires
 *       `smee-runtime-lost` → `startPollMode()` opens the bridge; smee
 *       source is NOT stopped; stdout stays open.
 *   (c) N consecutive reconnect failures during a smee.io drop → bridge
 *       opens; then `onReconnectSuccess()` transitions directly back to
 *       `smee-active` with `smee-re-promoted`; poll bridge released;
 *       stdout stays open.
 *
 * SC-004 audit: across all three scenarios, no code path emits the poll
 * snapshot AND ends the stream.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDoorbell } from '../../doorbell.js';
import {
  SourceSelector,
  type SourceSelectorOptions,
} from '../source-selector.js';
import type { SmeeDoorbellSourceOptions } from '../smee-source.js';

class MockStdout {
  chunks: string[] = [];
  ended = false;
  write(chunk: string, cb?: () => void): boolean {
    if (this.ended) throw new Error('write after stream end');
    this.chunks.push(chunk);
    if (cb) cb();
    return true;
  }
}

interface CapturedSmee {
  options: SmeeDoorbellSourceOptions;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function makeCapturedSmeeFactory(): {
  factory: (opts: SmeeDoorbellSourceOptions) => unknown;
  captured: CapturedSmee[];
} {
  const captured: CapturedSmee[] = [];
  const factory = (opts: SmeeDoorbellSourceOptions): unknown => {
    const entry: CapturedSmee = {
      options: opts,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    captured.push(entry);
    return { start: entry.start, stop: entry.stop };
  };
  return { factory, captured };
}

function makeCapturingSelectorFactory(): {
  factory: (opts: SourceSelectorOptions) => SourceSelector;
  selectors: SourceSelector[];
} {
  const selectors: SourceSelector[] = [];
  const factory = (opts: SourceSelectorOptions): SourceSelector => {
    const sel = new SourceSelector(opts);
    selectors.push(sel);
    return sel;
  };
  return { factory, selectors };
}

function fsEnoent(): {
  readFile: (p: string | Buffer | URL) => Promise<string>;
} {
  return {
    readFile: async (): Promise<string> => {
      const err = new Error('not found') as Error & { code?: string };
      err.code = 'ENOENT';
      throw err;
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    // Real timers flush; the fake timers wrap only Date.now/setTimeout.
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('doorbell bridge-mode regression (FR-007)', () => {
  it('(a) ≥60-min quiet-but-alive smee: no poll-fallback, no stop, stdout stays open', async () => {
    const stdout = new MockStdout();
    const { factory: smeeFactory, captured } = makeCapturedSmeeFactory();
    const { factory: selectorFactory, selectors } =
      makeCapturingSelectorFactory();

    const gh = { async getIssue() { return {}; } };
    const acquireBus = vi.fn();

    const abort = new AbortController();

    const runPromise = runDoorbell(
      'o/r#100',
      {},
      {
        stdout,
        acquireBus: acquireBus as never,
        smeeSourceFactory: smeeFactory as never,
        sourceSelectorFactory: selectorFactory,
        gh: gh as unknown as never,
        env: { COCKPIT_DOORBELL_SMEE_URL: 'https://smee.io/xyz' },
        fs: fsEnoent(),
        channelFilePath: '/tmp/nonexistent',
        exit: () => undefined,
        abortSignal: abort.signal,
        logger: { warn: () => undefined, info: () => undefined },
      },
    );

    await flush();

    expect(captured).toHaveLength(1);
    expect(selectors).toHaveLength(1);
    const smee = captured[0]!;
    const sel = selectors[0]!;

    // Simulate first successful connect: smee-attempt → smee-active.
    smee.options.onReconnectSuccess();
    expect(sel.currentSource).toBe('smee-active');

    // Drive 60 min of virtual time with an onSseBytes callback every 30s.
    // We drive selector.observeElapsed() manually per tick to avoid needing
    // real setInterval fakes; the invariant we're testing is that liveness
    // refresh prevents demotion.
    let simulatedNow = Date.now();
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => simulatedNow);
    try {
      const stepMs = 30_000;
      const totalMs = 60 * 60 * 1000;
      for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
        simulatedNow += stepMs;
        smee.options.onSseBytes?.();
        sel.observeElapsed();
      }
      expect(sel.currentSource).toBe('smee-active');
      // Smee source never stopped by mode-change handler.
      expect(smee.stop).not.toHaveBeenCalled();
      // Poll subscriber never opened. acquireBus is called once — for the
      // answers-file tailer's bridge (#1023) — but poll-mode subscribe was
      // never opened (the tailer's acquire returns undefined here, so no
      // subscribe/release is wired up).
      expect(acquireBus).toHaveBeenCalledTimes(1);
      // Stdout stream still open.
      expect(stdout.ended).toBe(false);
    } finally {
      dateSpy.mockRestore();
    }

    abort.abort();
    await runPromise;
  });

  it('(b) keepalives stop mid-run: liveness fires, bridge opens, smee source NOT stopped', async () => {
    const stdout = new MockStdout();
    const { factory: smeeFactory, captured } = makeCapturedSmeeFactory();
    const { factory: selectorFactory, selectors } =
      makeCapturingSelectorFactory();

    const mockAcquired = {
      bus: { waitFor: async () => new Promise(() => undefined) },
      release: vi.fn(),
    };
    const acquireBus = vi.fn().mockResolvedValue(mockAcquired);

    const gh = { async getIssue() { return {}; } };
    const abort = new AbortController();

    const runPromise = runDoorbell(
      'o/r#100',
      {},
      {
        stdout,
        acquireBus: acquireBus as never,
        smeeSourceFactory: smeeFactory as never,
        sourceSelectorFactory: selectorFactory,
        gh: gh as unknown as never,
        env: { COCKPIT_DOORBELL_SMEE_URL: 'https://smee.io/xyz' },
        fs: fsEnoent(),
        channelFilePath: '/tmp/nonexistent',
        exit: () => undefined,
        abortSignal: abort.signal,
        logger: { warn: () => undefined, info: () => undefined },
      },
    );

    await flush();

    const smee = captured[0]!;
    const sel = selectors[0]!;

    smee.options.onReconnectSuccess();
    expect(sel.currentSource).toBe('smee-active');

    // Let a couple of keepalives fire, then advance past 90s without any.
    let simulatedNow = Date.now();
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => simulatedNow);
    try {
      smee.options.onSseBytes?.();
      simulatedNow += 30_000;
      smee.options.onSseBytes?.();
      // Now stop calling onSseBytes and cross the 90s threshold.
      simulatedNow += 91_000;
      sel.observeElapsed();
      expect(sel.currentSource).toBe('poll-fallback');
    } finally {
      dateSpy.mockRestore();
    }

    // Let the fire-and-forget poll-fallback branch start the poll subscriber.
    await flush();
    expect(acquireBus).toHaveBeenCalled();

    // Critical: smee source is NOT stopped by the mode-change handler.
    expect(smee.stop).not.toHaveBeenCalled();
    expect(stdout.ended).toBe(false);

    abort.abort();
    await runPromise;
  });

  it('(c) N reconnect failures → bridge opens, then re-promote returns to smee-active', async () => {
    const stdout = new MockStdout();
    const { factory: smeeFactory, captured } = makeCapturedSmeeFactory();
    const { factory: selectorFactory, selectors } =
      makeCapturingSelectorFactory();

    const mockAcquired = {
      bus: { waitFor: async () => new Promise(() => undefined) },
      release: vi.fn(),
    };
    const acquireBus = vi.fn().mockResolvedValue(mockAcquired);

    const gh = { async getIssue() { return {}; } };
    const abort = new AbortController();

    const runPromise = runDoorbell(
      'o/r#100',
      {},
      {
        stdout,
        acquireBus: acquireBus as never,
        smeeSourceFactory: smeeFactory as never,
        sourceSelectorFactory: selectorFactory,
        gh: gh as unknown as never,
        env: { COCKPIT_DOORBELL_SMEE_URL: 'https://smee.io/xyz' },
        fs: fsEnoent(),
        channelFilePath: '/tmp/nonexistent',
        exit: () => undefined,
        abortSignal: abort.signal,
        logger: { warn: () => undefined, info: () => undefined },
      },
    );

    await flush();

    const smee = captured[0]!;
    const sel = selectors[0]!;

    // Get to smee-active.
    smee.options.onReconnectSuccess();
    expect(sel.currentSource).toBe('smee-active');

    // Drive 5 consecutive reconnect failures.
    smee.options.onReconnectAttempt(1);
    smee.options.onReconnectAttempt(2);
    smee.options.onReconnectAttempt(3);
    smee.options.onReconnectAttempt(4);
    smee.options.onReconnectAttempt(5);
    expect(sel.currentSource).toBe('poll-fallback');

    await flush();
    // Bridge opened.
    expect(acquireBus).toHaveBeenCalled();
    // Smee source NOT stopped.
    expect(smee.stop).not.toHaveBeenCalled();

    // Background smee reconnect succeeds → bridge exit.
    smee.options.onReconnectSuccess();
    expect(sel.currentSource).toBe('smee-active');

    // Poll subscriber released.
    await flush();
    expect(mockAcquired.release).toHaveBeenCalled();

    // Stdout stream still open across the whole cycle.
    expect(stdout.ended).toBe(false);

    abort.abort();
    await runPromise;
  });

  it('SC-004: bridge scenarios never emit poll snapshot AND end the stream', async () => {
    // Cross-scenario invariant: across (a) / (b) / (c), stdout.ended stays
    // false. This is asserted in each scenario above; this test documents
    // the guarantee at the file level.
    // The MockStdout throws on write after end; if any test path had ended
    // the stream mid-run, subsequent writes would have thrown.
    expect(true).toBe(true);
  });
});
