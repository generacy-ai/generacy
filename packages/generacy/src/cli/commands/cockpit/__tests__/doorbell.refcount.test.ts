import { afterEach, describe, expect, it } from 'vitest';
import type { CommandRunner } from '@generacy-ai/cockpit';
import { acquireEpicBus, _resetRegistryForTests } from '../mcp/event-bus-registry.js';

function stubRunner(): CommandRunner {
  return async () => ({ stdout: '', stderr: '', exitCode: 0 });
}

afterEach(() => {
  _resetRegistryForTests();
});

describe('doorbell in-process refcount (US2 AC-1, AC-2)', () => {
  it('T12 — two concurrent acquireEpicBus calls on the same ref share ONE poll loop (SC-002)', async () => {
    const runner = stubRunner();
    let cycles = 0;
    const runCycle = async (): Promise<void> => {
      cycles += 1;
    };

    // First acquire — creates the bus, starts the poll loop.
    const first = await acquireEpicBus({
      epicRef: 'owner/repo#100',
      runner,
      noPoll: true,
      runCycle,
    });

    // Second concurrent acquire on the same ref — refcount goes to 2, does NOT
    // spin up a second poll loop and does NOT trigger catch-up (wasPaused=false).
    const second = await acquireEpicBus({
      epicRef: 'owner/repo#100',
      runner,
      noPoll: true,
      runCycle,
    });

    expect(second.bus).toBe(first.bus);
    // Zero cycles: no catch-up (concurrent acquire), no scheduled poll ticks
    // (noPoll: true suppresses the poll loop; the runCycle counter therefore
    // measures the concurrent-acquire's shared-loop behavior).
    expect(cycles).toBe(0);

    second.release();
    first.release();
  });

  it('T13 — releasing one subscriber does not tear down the bus while another ref is held (US2 AC-2)', async () => {
    const runner = stubRunner();
    let cycles = 0;
    const runCycle = async (): Promise<void> => {
      cycles += 1;
    };

    const first = await acquireEpicBus({
      epicRef: 'owner/repo#100',
      runner,
      noPoll: true,
      runCycle,
    });
    const originalNonce = first.bus.busNonce;

    const second = await acquireEpicBus({
      epicRef: 'owner/repo#100',
      runner,
      noPoll: true,
      runCycle,
    });
    expect(second.bus).toBe(first.bus);

    // Release the first — refcount goes 2→1. The bus must survive: the second
    // ref is still held so no idle-TTL arms, no catch-up runs, no eviction.
    first.release();

    const third = await acquireEpicBus({
      epicRef: 'owner/repo#100',
      runner,
      noPoll: true,
      runCycle,
    });
    // Same bus instance (not evicted) — same busNonce.
    expect(third.bus.busNonce).toBe(originalNonce);
    expect(third.bus).toBe(first.bus);
    // No catch-up cycle fires: existing acquire while refcount was > 0 skips
    // catch-up (wasPaused=false).
    expect(cycles).toBe(0);

    third.release();
    second.release();
  });
});
