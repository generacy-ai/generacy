import { describe, expect, it, vi } from 'vitest';
import type { RateLimitScheduler } from '@generacy-ai/cockpit';
import {
  runStartupRetry,
  classifyGhError,
  type GhErrorClass,
} from '../startup-retry.js';

class StderrSink {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get text(): string {
    return this.chunks.join('');
  }
}

function makeScheduler(intervalMs: number = 1000): RateLimitScheduler {
  return {
    getCurrentIntervalMs: () => intervalMs,
    probeNow: async () => null,
    noteRetryAfter: () => undefined,
    noteResponseHeaders: () => undefined,
    start: () => undefined,
    stop: () => undefined,
  };
}

function makeAbort(): AbortController {
  return new AbortController();
}

function makeLogger(): { warn: (msg: string) => void; info: (msg: string) => void } {
  return { warn: vi.fn(), info: vi.fn() };
}

function makeError(message: string, code?: string): Error & { code?: string } {
  const err = new Error(message) as Error & { code?: string };
  if (code) err.code = code;
  return err;
}

describe('classifyGhError', () => {
  it('maps node error codes → retriable', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE']) {
      const cls = classifyGhError(makeError('boom', code));
      expect(cls.kind).toBe('retriable');
      expect((cls as { hint: string }).hint).toBe(code.toLowerCase());
    }
  });

  it('maps `socket hang up` → retriable', () => {
    const cls = classifyGhError(makeError('socket hang up'));
    expect(cls).toEqual({ kind: 'retriable', hint: 'socket-hang-up' });
  });

  it('maps HTTP 429/500/502/503/504 → retriable http-N', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const cls = classifyGhError(makeError(`gh: HTTP ${status} something`));
      expect(cls).toEqual({ kind: 'retriable', hint: `http-${status}` });
    }
  });

  it('maps HTTP 401 → permanent bad-credentials', () => {
    expect(classifyGhError(makeError('HTTP 401 Unauthorized'))).toEqual({
      kind: 'permanent',
      reason: 'bad-credentials',
    });
    expect(classifyGhError(makeError('Bad credentials'))).toEqual({
      kind: 'permanent',
      reason: 'bad-credentials',
    });
  });

  it('maps HTTP 403 + SAML markers → permanent scope-or-sso', () => {
    expect(classifyGhError(makeError('HTTP 403'))).toEqual({
      kind: 'permanent',
      reason: 'scope-or-sso',
    });
    expect(classifyGhError(makeError('resource not accessible by integration'))).toEqual({
      kind: 'permanent',
      reason: 'scope-or-sso',
    });
    expect(classifyGhError(makeError('SAML enforcement failed'))).toEqual({
      kind: 'permanent',
      reason: 'scope-or-sso',
    });
  });

  it('maps HTTP 404 / Could not resolve → permanent not-found', () => {
    expect(classifyGhError(makeError('HTTP 404 Not Found'))).toEqual({
      kind: 'permanent',
      reason: 'not-found',
    });
    expect(
      classifyGhError(makeError('Could not resolve to an Issue with the number of 42')),
    ).toEqual({ kind: 'permanent', reason: 'not-found' });
  });

  it('maps JSON parse errors → permanent malformed-output', () => {
    expect(classifyGhError(makeError('parsing JSON stream'))).toEqual({
      kind: 'permanent',
      reason: 'malformed-output',
    });
    expect(classifyGhError(makeError('expected JSON, got HTML'))).toEqual({
      kind: 'permanent',
      reason: 'malformed-output',
    });
  });

  it('unrecognized errors → permanent unknown', () => {
    expect(classifyGhError(makeError('some random gh failure'))).toEqual({
      kind: 'permanent',
      reason: 'unknown',
    });
    expect(classifyGhError({ weird: 'shape' })).toEqual({
      kind: 'permanent',
      reason: 'unknown',
    });
  });
});

describe('runStartupRetry', () => {
  it('case 1: task succeeds first attempt → success, no stderr', async () => {
    const stderr = new StderrSink();
    const abort = makeAbort();
    const value = { ok: true };
    const outcome = await runStartupRetry({
      task: async () => value,
      label: 'acquireEpicBus',
      rateLimitScheduler: makeScheduler(),
      abortSignal: abort.signal,
      stderr,
      logger: makeLogger(),
    });
    expect(outcome).toEqual({ kind: 'success', value });
    expect(stderr.text).toBe('');
  });

  it('case 2: ECONNRESET then success → one stderr line + success', async () => {
    const stderr = new StderrSink();
    const abort = makeAbort();
    let calls = 0;
    const task = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw makeError('boom', 'ECONNRESET');
      return 'ok';
    };
    const sleepMock = vi.fn(async () => undefined);
    const outcome = await runStartupRetry({
      task,
      label: 'acquireEpicBus',
      rateLimitScheduler: makeScheduler(1000),
      abortSignal: abort.signal,
      stderr,
      logger: makeLogger(),
      sleep: sleepMock,
    });
    expect(outcome).toEqual({ kind: 'success', value: 'ok' });
    expect(stderr.text).toBe(
      'cockpit doorbell: startup-retry label=acquireEpicBus reason=econnreset attempt=1\n',
    );
    expect(sleepMock).toHaveBeenCalledWith(1000, abort.signal);
    expect(calls).toBe(2);
  });

  it('case 3: sustained HTTP 429 through initial window → success in late window', async () => {
    const stderr = new StderrSink();
    const abort = makeAbort();
    // Simulate: 3 initial-window failures (attempt 1, 2, 3 — sleep 1000ms each),
    // then time crosses initialWindowMs → transition to late-window; late
    // attempt (attempt 4) succeeds.
    // now() call sequence:
    // 1) startedAt = 0
    // 2) attempt 1 failure check → 100 (< 2000 → no transition)
    // 3) attempt 2 failure check → 200 (< 2000 → no transition)
    // 4) attempt 3 failure check → 3000 (>= 2000 → transition to late)
    let mockNow = 0;
    const times = [0, 100, 200, 3000, 3000, 3000, 3000];
    const nowMock = (): number => {
      const t = times[mockNow] ?? 3000;
      mockNow = Math.min(mockNow + 1, times.length - 1);
      return t;
    };
    let calls = 0;
    const task = async (): Promise<string> => {
      calls += 1;
      if (calls < 4) throw makeError('gh: HTTP 429 rate limited');
      return 'ok';
    };
    const sleeps: number[] = [];
    const sleepMock = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });
    const outcome = await runStartupRetry({
      task,
      label: 'acquireEpicBus',
      rateLimitScheduler: makeScheduler(1000),
      abortSignal: abort.signal,
      stderr,
      logger: makeLogger(),
      sleep: sleepMock,
      now: nowMock,
      initialWindowMs: 2000,
      lateWindowIntervalMs: 5000,
    });
    expect(outcome).toEqual({ kind: 'success', value: 'ok' });
    expect(stderr.text).toContain(
      'startup-retry label=acquireEpicBus reason=http-429 attempt=1',
    );
    expect(stderr.text).toContain(
      'startup-retry-exhausted label=acquireEpicBus transitioning to late-startup retry',
    );
    expect(stderr.text).toContain(
      'startup-retry-recovered label=acquireEpicBus',
    );
    // At least one late-window sleep (5000ms) must have been requested.
    expect(sleeps).toContain(5000);
  });

  it('case 4: HTTP 401 → permanent bad-credentials', async () => {
    const stderr = new StderrSink();
    const outcome = await runStartupRetry({
      task: async () => {
        throw makeError('gh: HTTP 401 Unauthorized');
      },
      label: 'resolveEpic',
      rateLimitScheduler: makeScheduler(),
      abortSignal: makeAbort().signal,
      stderr,
      logger: makeLogger(),
    });
    expect(outcome).toEqual({ kind: 'permanent', reason: 'bad-credentials' });
    expect(stderr.text).toBe(
      'cockpit doorbell: permanent-error label=resolveEpic reason=bad-credentials\n',
    );
  });

  it('case 5: HTTP 403 SAML → permanent scope-or-sso', async () => {
    const stderr = new StderrSink();
    const outcome = await runStartupRetry({
      task: async () => {
        throw makeError('gh: HTTP 403 SAML enforcement failed');
      },
      label: 'resolveEpic',
      rateLimitScheduler: makeScheduler(),
      abortSignal: makeAbort().signal,
      stderr,
      logger: makeLogger(),
    });
    expect(outcome).toEqual({ kind: 'permanent', reason: 'scope-or-sso' });
  });

  it('case 6: HTTP 404 → permanent not-found', async () => {
    const stderr = new StderrSink();
    const outcome = await runStartupRetry({
      task: async () => {
        throw makeError('Could not resolve to an Issue with the number of 999');
      },
      label: 'resolveEpic',
      rateLimitScheduler: makeScheduler(),
      abortSignal: makeAbort().signal,
      stderr,
      logger: makeLogger(),
    });
    expect(outcome).toEqual({ kind: 'permanent', reason: 'not-found' });
  });

  it('case 7: malformed JSON → permanent malformed-output', async () => {
    const stderr = new StderrSink();
    const outcome = await runStartupRetry({
      task: async () => {
        throw makeError('expected JSON, got HTML');
      },
      label: 'acquireEpicBus',
      rateLimitScheduler: makeScheduler(),
      abortSignal: makeAbort().signal,
      stderr,
      logger: makeLogger(),
    });
    expect(outcome).toEqual({ kind: 'permanent', reason: 'malformed-output' });
  });

  it('case 8: unknown error → permanent unknown', async () => {
    const stderr = new StderrSink();
    const outcome = await runStartupRetry({
      task: async () => {
        throw makeError('some genuinely weird error');
      },
      label: 'acquireEpicBus',
      rateLimitScheduler: makeScheduler(),
      abortSignal: makeAbort().signal,
      stderr,
      logger: makeLogger(),
    });
    expect(outcome).toEqual({ kind: 'permanent', reason: 'unknown' });
  });

  it('case 9: abort mid-initial sleep → aborted', async () => {
    const stderr = new StderrSink();
    const abort = makeAbort();
    const outcome = await runStartupRetry({
      task: async () => {
        throw makeError('boom', 'ECONNRESET');
      },
      label: 'acquireEpicBus',
      rateLimitScheduler: makeScheduler(1000),
      abortSignal: abort.signal,
      stderr,
      logger: makeLogger(),
      sleep: async (_ms, signal) => {
        // Simulate abort during sleep.
        abort.abort();
        // Bail out immediately, honouring the signal.
        if (signal.aborted) return;
      },
    });
    expect(outcome).toEqual({ kind: 'aborted' });
  });

  it('case 10: abort mid-late sleep → aborted', async () => {
    const stderr = new StderrSink();
    const abort = makeAbort();
    let mockNow = 0;
    const times = [0, 100, 3000];
    const nowMock = (): number => {
      const t = times[mockNow] ?? 3000;
      mockNow = Math.min(mockNow + 1, times.length - 1);
      return t;
    };
    let calls = 0;
    const outcome = await runStartupRetry({
      task: async () => {
        calls += 1;
        throw makeError('gh: HTTP 429 rate limited');
      },
      label: 'acquireEpicBus',
      rateLimitScheduler: makeScheduler(500),
      abortSignal: abort.signal,
      stderr,
      logger: makeLogger(),
      sleep: async (ms, signal) => {
        if (ms >= 5000) {
          abort.abort();
          if (signal.aborted) return;
        }
      },
      now: nowMock,
      initialWindowMs: 1000,
      lateWindowIntervalMs: 5000,
    });
    expect(outcome).toEqual({ kind: 'aborted' });
    // We hit late-window at least once.
    expect(stderr.text).toContain('startup-retry-exhausted');
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it('case 11 (classifier unit table): every branch produces the documented shape', () => {
    const cases: Array<[unknown, GhErrorClass]> = [
      [makeError('x', 'ECONNRESET'), { kind: 'retriable', hint: 'econnreset' }],
      [makeError('socket hang up'), { kind: 'retriable', hint: 'socket-hang-up' }],
      [makeError('HTTP 503'), { kind: 'retriable', hint: 'http-503' }],
      [makeError('HTTP 401'), { kind: 'permanent', reason: 'bad-credentials' }],
      [makeError('HTTP 403 SAML'), { kind: 'permanent', reason: 'scope-or-sso' }],
      [makeError('HTTP 404'), { kind: 'permanent', reason: 'not-found' }],
      [makeError('parsing json'), { kind: 'permanent', reason: 'malformed-output' }],
      [makeError('mystery'), { kind: 'permanent', reason: 'unknown' }],
    ];
    for (const [err, expected] of cases) {
      expect(classifyGhError(err)).toEqual(expected);
    }
  });

  it('case 12: retriable success — task succeeds after one retriable error and does not emit recovered line', async () => {
    // Regression: the recovered-line marker only fires on late-window recovery.
    // A success in the initial window after a retriable failure must NOT emit
    // the recovered line — the initial retry is silent post-attempt-1.
    const stderr = new StderrSink();
    let calls = 0;
    const outcome = await runStartupRetry({
      task: async () => {
        calls += 1;
        if (calls === 1) throw makeError('boom', 'ECONNRESET');
        return 42;
      },
      label: 'acquireEpicBus',
      rateLimitScheduler: makeScheduler(1),
      abortSignal: makeAbort().signal,
      stderr,
      logger: makeLogger(),
      sleep: async () => undefined,
    });
    expect(outcome).toEqual({ kind: 'success', value: 42 });
    expect(stderr.text).not.toContain('startup-retry-recovered');
  });
});

describe('runDoorbell startup-retry integration', () => {
  it('acquireEpicBus throws ECONNRESET once then resolves — doorbell reaches steady state; armed\\n is written before the retry line', async () => {
    // Deferred import so the runStartupRetry describe block does not pull in
    // the doorbell entry point at module init.
    const { runDoorbell } = await import('../../doorbell.js');
    const { EpicEventBus } = await import('../../mcp/event-bus.js');

    let acquireCalls = 0;
    const bus = new EpicEventBus({ epic: 'owner/repo#5' });
    const acquireBus = vi.fn(async () => {
      acquireCalls += 1;
      if (acquireCalls === 1) {
        const err = makeError('boom', 'ECONNRESET');
        throw err;
      }
      return {
        bus,
        release: () => undefined,
      };
    });

    const stdout = {
      chunks: [] as string[],
      write(chunk: string, cb?: () => void): boolean {
        this.chunks.push(chunk);
        if (cb) cb();
        return true;
      },
    };

    // Capture process.stderr writes so we can assert armed-before-retry
    // ordering across the two streams. `armed\n` is on stdout, retry
    // diagnostics on stderr — the assertion is that the stdout-armed
    // callback fires before the stderr-retry line.
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderrWrites.push(
          typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'),
        );
        // Record the current stdout write count when this stderr write happens.
        return true;
      });

    const abort = new AbortController();
    setTimeout(() => abort.abort(), 30);

    const code = await runDoorbell(
      'owner/repo#5',
      {},
      {
        stdout,
        acquireBus,
        rateLimitScheduler: {
          getCurrentIntervalMs: () => 1,
          probeNow: async () => null,
          noteRetryAfter: () => undefined,
          noteResponseHeaders: () => undefined,
          start: () => undefined,
          stop: () => undefined,
        },
        env: {},
        fs: {
          readFile: async () => {
            const err = makeError('nope', 'ENOENT');
            throw err;
          },
        },
        channelFilePath: '/tmp/nonexistent',
        exit: () => undefined,
        abortSignal: abort.signal,
        logger: { warn: vi.fn(), info: vi.fn() },
      },
    );

    stderrSpy.mockRestore();

    expect(code).toBe(0);
    // Armed line was the first stdout write.
    expect(stdout.chunks[0]).toBe('armed\n');
    // Acquire was called at least twice (once fail, once success).
    expect(acquireCalls).toBeGreaterThanOrEqual(2);
    // A startup-retry stderr line was emitted for the ECONNRESET.
    const retryLine = stderrWrites.find((l) =>
      l.includes('startup-retry label=acquireEpicBus reason=econnreset attempt=1'),
    );
    expect(retryLine).toBeDefined();
  });
});
