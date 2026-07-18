import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmeeDoorbellSource } from '../smee-source.js';
import type { GhWrapper } from '@generacy-ai/cockpit';

const FAKE_RESOLVED = {
  epic: { repo: 'o/r', number: 100 },
  parsed: { phases: [], adhocRefs: [], allRefs: [{ repo: 'o/r', number: 42 }], warnings: [] },
  repos: ['o/r'],
  bodyHash: 'x',
};

vi.mock('@generacy-ai/cockpit', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveEpic: vi.fn(async () => FAKE_RESOLVED),
  };
});

/**
 * Returns a fake Response whose body stream drains immediately (`done: true`
 * on first read). The runLoop treats this as a clean connect that eventually
 * closes — resetting `reconnectAttempt` to 0 and re-entering the loop.
 */
function drainedSuccessResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/**
 * Yields to microtasks enough for the runLoop to progress from a fetch
 * settlement through the catch/try branch and back to `await sleep(...)`.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/**
 * Extract the sleep ms value from a warn log message of the shape:
 *   `... reconnecting in ${sleepMs}ms (attempt N): ...`
 */
function parseSleepMs(msg: string): number | null {
  const m = /reconnecting in (\d+(?:\.\d+)?)ms/.exec(msg);
  return m == null ? null : Number(m[1]);
}

describe('SmeeDoorbellSource — reconnect loop (SC-002, FR-008)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('saturated ladder never exceeds the 30_000ms cap; reconnectAttempt resets to 0 on success', async () => {
    // 4 rejections saturate the ladder (attempt=3 → raw=40000, capped=30000);
    // 5th call returns a successful (immediately-drained) SSE response.
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount <= 4) {
        throw new Error(`simulated smee outage (call ${callCount})`);
      }
      return drainedSuccessResponse();
    });

    const warnMessages: string[] = [];
    const reconnectAttempts: number[] = [];
    let successes = 0;

    const source = new SmeeDoorbellSource({
      channelUrl: 'http://smee.example/channel',
      epicRef: 'o/r#100',
      gh: {} as unknown as GhWrapper,
      logger: {
        warn: (msg) => {
          warnMessages.push(msg);
        },
        info: () => undefined,
      },
      onEvent: async () => undefined,
      onReconnectAttempt: (n) => {
        reconnectAttempts.push(n);
      },
      onReconnectSuccess: () => {
        successes++;
      },
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      baseReconnectDelayMs: 5_000,
    });

    await source.start();

    // Drive 4 failed iterations. Each iteration:
    //  1) fetch rejects → catch increments reconnectAttempt, logs sleep ms
    //  2) `await sleep(sleepMs)` schedules a setTimeout
    //  3) advance timers past pending sleep, flush microtasks so the next
    //     iteration's fetch fires and rejects again.
    for (let i = 0; i < 4; i++) {
      await flushMicrotasks();
      await vi.runOnlyPendingTimersAsync();
      await flushMicrotasks();
    }

    // After 4 iterations, warnMessages holds 4 entries — one per failed attempt.
    expect(warnMessages.length).toBeGreaterThanOrEqual(4);
    expect(reconnectAttempts.length).toBeGreaterThanOrEqual(4);

    // Every observed sleep must stay strictly below the 30_000ms cap (SC-002).
    const sleepMsValues = warnMessages
      .map(parseSleepMs)
      .filter((v): v is number => v != null);
    expect(sleepMsValues.length).toBe(warnMessages.length);
    for (const sleepMs of sleepMsValues) {
      expect(sleepMs).toBeLessThan(30_000);
    }
    // The saturated tail (attempts >= 3 with base=5000 → raw≥40000, capped=30000)
    // must land in the [cap/2, cap) band.
    const saturatedTail = sleepMsValues.slice(-2);
    for (const sleepMs of saturatedTail) {
      expect(sleepMs).toBeGreaterThanOrEqual(15_000);
      expect(sleepMs).toBeLessThan(30_000);
    }

    // Advance past the last failure's sleep; the 5th fetch call succeeds.
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();

    // The reader stream is drained immediately, so connect() returns; the loop
    // resets reconnectAttempt to 0 and enters the post-success sleep before
    // the next fetch attempt.
    expect(successes).toBeGreaterThanOrEqual(1);

    // Now trigger one more failure by advancing past the post-success sleep
    // and letting the next fetch call fire. Since callCount > 5, the fetch
    // mock throws again.
    // We need callCount 6+ to fail — extend fetchImpl to always throw after
    // the first success.
    fetchImpl.mockImplementation(async () => {
      throw new Error('post-success failure');
    });

    const priorWarnCount = warnMessages.length;
    await vi.runOnlyPendingTimersAsync(); // advance post-success sleep
    await flushMicrotasks();

    // Now the next iteration ran, fetch threw, and a new warn was logged
    // with sleepMs derived from reconnectAttempt=1 (post-reset).
    // FR-008: `reconnectAttempt` reset to 0 on success, so the next failure
    // sets reconnectAttempt=1, giving sleep ∈ [5000, 10000) — nowhere near
    // the saturated [15000, 30000) band.
    expect(warnMessages.length).toBeGreaterThan(priorWarnCount);
    const postResetSleepMs = parseSleepMs(warnMessages[warnMessages.length - 1]!);
    expect(postResetSleepMs).not.toBeNull();
    expect(postResetSleepMs!).toBeGreaterThanOrEqual(5_000);
    expect(postResetSleepMs!).toBeLessThan(10_000);

    await source.stop();
  });
});
