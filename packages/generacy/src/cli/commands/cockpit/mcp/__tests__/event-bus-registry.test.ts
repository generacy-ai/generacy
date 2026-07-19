import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '@generacy-ai/cockpit';
import { acquireEpicBus, _resetRegistryForTests } from '../event-bus-registry.js';
import type { CockpitStreamEvent } from '../../watch/stream-event.js';

/**
 * `acquireEpicBus` runs the input through `resolveIssueContext`, which shells
 * out via a `CommandRunner`. In tests we substitute a runner that treats
 * every `owner/repo#N` string as pre-resolved (no `gh` calls).
 */
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

afterEach(() => {
  _resetRegistryForTests();
  vi.useRealTimers();
});

describe('event-bus-registry lifecycle', () => {
  it('SC-001: sequential acquire/release/acquire returns the same bus and preserves nextCursor', async () => {
    const runner = stubRunner();
    const first = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#917',
      runner,
      noPoll: true,
      runCycle: async () => undefined,
    });
    first.bus.emit(makeEvent(918));
    const firstBusNonce = first.bus.busNonce;
    first.release();

    const second = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#917',
      runner,
      noPoll: true,
      runCycle: async () => undefined,
    });
    expect(second.bus).toBe(first.bus);
    expect(second.bus.busNonce).toBe(firstBusNonce);
    // nextCursor preserved — a new emit continues from the previous counter.
    const entry = second.bus.emit(makeEvent(919));
    expect(entry.cursor).toBe(2);
    second.release();
  });

  it('R-I1: refCount > 0 XOR idleTimer != null across acquire/release/acquire', async () => {
    vi.useFakeTimers();
    const runner = stubRunner();
    // Peek at internal registry state via a small helper.
    const acquireA = async () =>
      acquireEpicBus({
        epicRef: 'generacy-ai/generacy#917',
        runner,
        noPoll: true,
        runCycle: async () => undefined,
        idleTtlMs: 60_000,
      });

    const first = await acquireA();
    // While held, no idle timer (refCount > 0).
    // We assert this behaviorally by advancing time past TTL and confirming
    // the bus is NOT evicted.
    vi.advanceTimersByTime(120_000);
    const stillFirst = await acquireA();
    expect(stillFirst.bus).toBe(first.bus);
    stillFirst.release();
    first.release();
    // Now refCount = 0. Timer armed. Advance past TTL — bus should be evicted.
    vi.advanceTimersByTime(120_000);
    const rebuilt = await acquireA();
    expect(rebuilt.bus).not.toBe(first.bus);
    rebuilt.release();
  });

  it('FR-002: idle-TTL fires and the registry drops the entry', async () => {
    vi.useFakeTimers();
    const runner = stubRunner();
    const first = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#917',
      runner,
      noPoll: true,
      runCycle: async () => undefined,
      idleTtlMs: 60_000,
    });
    const originalNonce = first.bus.busNonce;
    first.release();
    // Under TTL — bus survives.
    vi.advanceTimersByTime(30_000);
    const stillAlive = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#917',
      runner,
      noPoll: true,
      runCycle: async () => undefined,
      idleTtlMs: 60_000,
    });
    expect(stillAlive.bus.busNonce).toBe(originalNonce);
    stillAlive.release();
    // Advance past the newly-armed TTL window — bus evicted.
    vi.advanceTimersByTime(120_000);
    const rebuilt = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#917',
      runner,
      noPoll: true,
      runCycle: async () => undefined,
      idleTtlMs: 60_000,
    });
    expect(rebuilt.bus.busNonce).not.toBe(originalNonce);
    rebuilt.release();
  });

  it('SC-002 / FR-004: catch-up poll delivers events emitted between acquires', async () => {
    const runner = stubRunner();
    let cycleCount = 0;
    const runCycle = async (bus: { emit: (e: CockpitStreamEvent) => unknown }) => {
      cycleCount += 1;
      // The catch-up cycle triggered on re-acquire synthesizes an event.
      bus.emit(makeEvent(918));
    };
    const first = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#917',
      runner,
      noPoll: true,
      runCycle,
    });
    // First acquire (fresh bus) does not trigger catch-up.
    expect(cycleCount).toBe(0);
    first.release();

    const second = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#917',
      runner,
      noPoll: true,
      runCycle,
    });
    // Second acquire triggered a catch-up cycle which emitted event 918.
    expect(cycleCount).toBe(1);
    const result = await second.bus.waitFor({
      sinceCursor: 0,
      maxWaitMs: 0,
      coalesceWindowMs: 0,
      maxBatchSize: 10,
    });
    expect(result.entries.length).toBe(1);
    expect((result.entries[0]!.event as { number?: number }).number).toBe(918);
    second.release();
  });

  it('FR-007: LRU soft-cap evicts the least-recently-active bus', async () => {
    const runner = stubRunner();
    const a = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#1',
      runner,
      noPoll: true,
      runCycle: async () => undefined,
      maxBuses: 2,
    });
    a.release();

    const b = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#2',
      runner,
      noPoll: true,
      runCycle: async () => undefined,
      maxBuses: 2,
    });
    b.release();

    // Add a third — should evict the LRU (a).
    const warnings: string[] = [];
    const c = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#3',
      runner,
      noPoll: true,
      runCycle: async () => undefined,
      maxBuses: 2,
      logger: { warn: (msg) => warnings.push(msg) },
    });
    expect(warnings.some((w) => w.includes('LRU eviction'))).toBe(true);
    c.release();

    // Re-acquiring #1 should build a fresh bus (busNonce differs).
    const reAcquiredA = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#1',
      runner,
      noPoll: true,
      runCycle: async () => undefined,
      maxBuses: 3,
    });
    expect(reAcquiredA.bus.busNonce).not.toBe(a.bus.busNonce);
    reAcquiredA.release();
  });

  it('SC-001/FR-008(a): quiet gap ≥ old TTL but ≤ new horizon → pre-gap cursor still classifies valid', async () => {
    // The injected `idleTtlMs: 60_000` stands in for the production 120-min
    // horizon at test scale. The pre-gap advance of 30_000 ms stands in for a
    // gap that used to fire the old 10-min TTL — long enough to reproduce the
    // failure mode, safely inside the injected horizon.
    vi.useFakeTimers();
    const runner = stubRunner();
    const first = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#917',
      runner,
      noPoll: true,
      runCycle: async () => undefined,
      idleTtlMs: 60_000,
    });
    const originalNonce = first.bus.busNonce;
    first.release();

    // Gap larger than the old 10-min TTL, still well under the injected horizon.
    vi.advanceTimersByTime(30_000);

    const rearm = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#917',
      runner,
      noPoll: true,
      runCycle: async () => undefined,
      idleTtlMs: 60_000,
    });
    expect(rearm.bus.busNonce).toBe(originalNonce);
    rearm.release();
  });

  it('SC-003/FR-008(b): gap exceeds horizon → bus IS torn down (idle-TTL reclaim still fires)', async () => {
    vi.useFakeTimers();
    const runner = stubRunner();
    const first = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#917',
      runner,
      noPoll: true,
      runCycle: async () => undefined,
      idleTtlMs: 60_000,
    });
    const originalNonce = first.bus.busNonce;
    first.release();

    // Gap past the horizon → idle-TTL fires, bus torn down.
    vi.advanceTimersByTime(60_001);

    const rebuilt = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#917',
      runner,
      noPoll: true,
      runCycle: async () => undefined,
      idleTtlMs: 60_000,
    });
    expect(rebuilt.bus.busNonce).not.toBe(originalNonce);
    rebuilt.release();
  });

  it('existing-bus acquire runs catch-up only when the poller was paused', async () => {
    const runner = stubRunner();
    let cycles = 0;
    const runCycle = async () => {
      cycles += 1;
    };
    const first = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#42',
      runner,
      noPoll: true,
      runCycle,
    });
    // Concurrent acquire — refcount goes to 2, poller was never paused.
    const concurrent = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#42',
      runner,
      noPoll: true,
      runCycle,
    });
    expect(cycles).toBe(0); // catch-up skipped because wasPaused=false
    concurrent.release();
    first.release();

    // Now refcount=0 and paused. Re-acquire → catch-up runs.
    const rearm = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#42',
      runner,
      noPoll: true,
      runCycle,
    });
    expect(cycles).toBe(1);
    rearm.release();
  });
});
