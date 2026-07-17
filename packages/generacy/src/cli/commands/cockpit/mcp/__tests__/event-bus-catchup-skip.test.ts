import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '@generacy-ai/cockpit';
import { acquireEpicBus, _resetRegistryForTests } from '../event-bus-registry.js';
import type { CockpitStreamEvent } from '../../watch/stream-event.js';

function stubRunner(): CommandRunner {
  return async () => ({ stdout: '', stderr: '', exitCode: 0 });
}

function makeEvent(n: number): CockpitStreamEvent {
  return {
    type: 'issue-transition',
    ts: '2026-07-11T00:00:00.000Z',
    repo: 'generacy-ai/generacy',
    kind: 'issue',
    number: n,
    from: null,
    to: 'waiting:clarification',
    sourceLabel: 'waiting-for:clarification',
    url: `https://github.com/generacy-ai/generacy/issues/${n}`,
    event: 'label-change',
    labels: ['waiting-for:clarification'],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

afterEach(() => {
  _resetRegistryForTests();
  vi.useRealTimers();
});

describe('event-bus catchup + skipNextCycle', () => {
  it('after catch-up + resume, next loop iteration is skipped (single runCycle call, not two)', async () => {
    vi.useFakeTimers();
    const runner = stubRunner();
    let cycleCount = 0;
    const runCycle = async (bus: { emit: (e: CockpitStreamEvent) => unknown }): Promise<void> => {
      cycleCount += 1;
      bus.emit(makeEvent(cycleCount));
    };

    const first = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#100',
      runner,
      intervalMs: 30_000,
      runCycle,
    });
    // Loop iteration 1 fires immediately (no sleep gate before the first
    // runCycle call). Flush the microtask queue so the initial cycle lands.
    await flush();
    expect(cycleCount).toBe(1);

    first.release();
    // Loop moved to paused state.
    await flush();

    const second = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#100',
      runner,
      intervalMs: 30_000,
      runCycle,
    });
    // Catch-up cycle ran (+1). The loop resumes, sees skipNextCycle=true, and
    // sleeps for the full interval WITHOUT invoking runCycle again.
    await flush();
    expect(cycleCount).toBe(2);

    // Confirm the catch-up event survived onto the bus for downstream consumers
    // (per plan Risk 6 — the skip only elides a duplicate poll, not any
    // pending emissions).
    const result = await second.bus.waitFor({
      sinceCursor: 1,
      maxWaitMs: 0,
      coalesceWindowMs: 0,
      maxBatchSize: 10,
    });
    expect(result.entries.length).toBe(1);

    // Advance past two sleeps: the first is the pre-existing sleep the loop
    // was mid-way through when release fired; the second is the "skipped
    // cycle" sleep armed just above. Only after both fire does the loop
    // arrive at a non-skipped iteration and call runCycle again.
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.advanceTimersByTimeAsync(31_000);
    await flush();
    expect(cycleCount).toBe(3);

    second.release();
  });
});
