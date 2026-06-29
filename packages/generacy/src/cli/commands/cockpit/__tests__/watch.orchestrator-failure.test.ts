import { describe, expect, it } from 'vitest';
import type {
  JobsResult,
  OrchestratorClient,
  WorkersResult,
} from '@generacy-ai/cockpit';
import {
  pollOrchestratorCounts,
  type OrchestratorCountsEvent,
  type OrchestratorCountsState,
} from '../watch/orchestrator-counts.js';
import {
  createFirstFailureWarner,
  type WarnSink,
} from '../shared/orchestrator-warn.js';

class CaptureSink implements WarnSink {
  public readonly messages: string[] = [];
  write(message: string): void {
    this.messages.push(message);
  }
}

function failingClient(reason: 'cloud-unreachable' | 'http-error'): OrchestratorClient {
  const jobs: JobsResult = { available: false, reason };
  const workers: WorkersResult = { available: false, reason };
  return {
    isAvailable: () => true,
    health: async () => ({ available: false, reason }),
    getJobs: async () => jobs,
    getWorkers: async () => workers,
  };
}

describe('watch orchestrator failure — emit-and-warn discipline across many ticks', () => {
  it('cloud-unreachable on every tick: 1 baseline emit + 0 follow-ups; stderr fires once', async () => {
    const sink = new CaptureSink();
    const warner = createFirstFailureWarner(sink);
    const c = failingClient('cloud-unreachable');

    const emitted: OrchestratorCountsEvent[] = [];
    let prev: OrchestratorCountsState | null = null;
    for (let i = 0; i < 5; i++) {
      const result = await pollOrchestratorCounts(c, prev, warner);
      if (result.event !== null) {
        emitted.push(result.event);
      }
      prev = result.curr;
    }

    // Baseline emit on tick 1; ticks 2-5 are silent.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      type: 'orchestrator-counts',
      available: false,
      reason: 'cloud-unreachable',
    });

    // stderr warning fired exactly once across all 5 ticks.
    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]).toBe(
      'cockpit: orchestrator unavailable: cloud-unreachable\n',
    );
    expect(warner.hasFired()).toBe(true);
  });

  it('http-error on every tick: same discipline', async () => {
    const sink = new CaptureSink();
    const warner = createFirstFailureWarner(sink);
    const c = failingClient('http-error');

    const emitted: OrchestratorCountsEvent[] = [];
    let prev: OrchestratorCountsState | null = null;
    for (let i = 0; i < 10; i++) {
      const result = await pollOrchestratorCounts(c, prev, warner);
      if (result.event !== null) {
        emitted.push(result.event);
      }
      prev = result.curr;
    }

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      type: 'orchestrator-counts',
      available: false,
      reason: 'http-error',
    });
    expect(sink.messages).toEqual([
      'cockpit: orchestrator unavailable: http-error\n',
    ]);
  });

  it('orchestrator failure never throws — the watch loop is structurally safe (SC-005)', async () => {
    const sink = new CaptureSink();
    const warner = createFirstFailureWarner(sink);
    const c = failingClient('cloud-unreachable');

    // The contract here is structural: pollOrchestratorCounts must always
    // resolve to {event, curr}, never reject. If it did, the watch loop
    // would crash on the `await ocPromise`. Drive it many times to be sure.
    let prev: OrchestratorCountsState | null = null;
    for (let i = 0; i < 20; i++) {
      await expect(
        pollOrchestratorCounts(c, prev, warner),
      ).resolves.toBeDefined();
      prev = { kind: 'unavailable', reason: 'cloud-unreachable' };
    }
  });

  it('transition: failing → recovered → failing produces baseline + recovery + re-fail events (3 emits), but stderr stays at 1', async () => {
    const sink = new CaptureSink();
    const warner = createFirstFailureWarner(sink);
    const failing = failingClient('cloud-unreachable');
    const healthy: OrchestratorClient = {
      isAvailable: () => true,
      health: async () => ({ available: false, reason: 'no-token' }),
      getJobs: async () => ({
        available: true,
        jobs: [{ id: 'j1', status: 'queued' }],
      }),
      getWorkers: async () => ({ available: true, count: 1 }),
    };

    const emitted: OrchestratorCountsEvent[] = [];
    let prev: OrchestratorCountsState | null = null;

    // Tick 1: failing (baseline → emit unavailable)
    let result = await pollOrchestratorCounts(failing, prev, warner);
    if (result.event !== null) emitted.push(result.event);
    prev = result.curr;

    // Tick 2: still failing same reason (no emit)
    result = await pollOrchestratorCounts(failing, prev, warner);
    if (result.event !== null) emitted.push(result.event);
    prev = result.curr;

    // Tick 3: recovered (transition → emit available)
    result = await pollOrchestratorCounts(healthy, prev, warner);
    if (result.event !== null) emitted.push(result.event);
    prev = result.curr;

    // Tick 4: failing again (transition → emit unavailable)
    result = await pollOrchestratorCounts(failing, prev, warner);
    if (result.event !== null) emitted.push(result.event);
    prev = result.curr;

    expect(emitted).toHaveLength(3);
    expect(emitted[0]).toEqual({
      type: 'orchestrator-counts',
      available: false,
      reason: 'cloud-unreachable',
    });
    expect(emitted[1]).toEqual({
      type: 'orchestrator-counts',
      jobs: 1,
      workers: 1,
    });
    expect(emitted[2]).toEqual({
      type: 'orchestrator-counts',
      available: false,
      reason: 'cloud-unreachable',
    });

    // Crucially: stderr stayed at one line across all 4 ticks.
    expect(sink.messages).toHaveLength(1);
  });
});
