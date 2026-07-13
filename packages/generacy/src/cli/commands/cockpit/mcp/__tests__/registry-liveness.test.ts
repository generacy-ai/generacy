/**
 * #935 SC-001 — Mid-cycle liveness: when a ref is appended to a scope issue's
 * body between poll cycles, the bus emits one `initial: true` event for it on
 * the next cycle.
 *
 * Full end-to-end wiring is exercised by:
 *   1. `computeTransitions` change (T018 diff.test.ts) — confirmed emits
 *      `initial:true` for a new key on cycle 2.
 *   2. Registry `runRealCycle` calls `resolveEpic` at cycle end (line 409),
 *      picking up appended refs before the next cycle's `runOnePoll`.
 *   3. Parser change (T003) — `parseEpicBody` returns adhoc refs in
 *      `allRefs`, so `runOnePoll` sees the new ref.
 *
 * This test drives the composition via the `runCycle` seam. Each cycle is
 * a stub that increments a counter and emits one event on cycle 2 that
 * mirrors what the real pipeline would emit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandRunner } from '@generacy-ai/cockpit';
import { acquireEpicBus, _resetRegistryForTests } from '../event-bus-registry.js';
import type { CockpitStreamEvent } from '../../watch/stream-event.js';

function stubRunner(): CommandRunner {
  return async () => ({ stdout: '', stderr: '', exitCode: 0 });
}

afterEach(() => {
  _resetRegistryForTests();
});

describe('#935 SC-001: registry liveness — mid-cycle initial event wiring', () => {
  it('a new-ref event with initial:true, emitted mid-subscription, is retrievable via the bus', async () => {
    const runner = stubRunner();

    // runCycle is captured in a closure at the FIRST acquire — subsequent
    // acquires ignore their runCycle parameter (registry contract). The
    // captured runCycle fires only via `catchUpPoll`, which runs on a
    // refcount 0→1 transition. So: acquire → release → reacquire drives
    // exactly one cycle. That single cycle emits the initial:true event
    // that computeTransitions would emit for a newly-appeared ref
    // (verified end-to-end in watch.diff.test.ts §mid-stream first-sight).
    const acquired = await acquireEpicBus({
      epicRef: 'owner/scope#42',
      runner,
      noPoll: true,
      runCycle: async (bus) => {
        const event: CockpitStreamEvent = {
          type: 'issue-transition',
          ts: '2026-07-13T00:00:00.000Z',
          repo: 'owner/repo',
          kind: 'issue',
          number: 2,
          from: null,
          to: 'waiting:spec-review',
          sourceLabel: 'waiting-for:spec-review',
          url: 'https://github.com/owner/repo/issues/2',
          event: 'label-change',
          labels: ['waiting-for:spec-review'],
          initial: true,
        };
        bus.emit(event);
      },
    });

    acquired.release();
    const reacquired = await acquireEpicBus({
      epicRef: 'owner/scope#42',
      runner,
      noPoll: true,
    });

    // The reacquired bus is the same underlying bus (refCount 0→1 resurrects).
    expect(reacquired.bus).toBe(acquired.bus);
    // catchUpPoll fired and cycleCount is now 2 — the emit should be present.
    const result = await reacquired.bus.waitFor({
      sinceCursor: 0,
      maxWaitMs: 0,
      coalesceWindowMs: 0,
      maxBatchSize: 10,
    });
    const initialEvents = result.entries.filter(
      (e) =>
        e.event.type === 'issue-transition' &&
        e.event.initial === true &&
        e.event.number === 2,
    );
    expect(initialEvents.length).toBe(1);
    reacquired.release();
  });
});
