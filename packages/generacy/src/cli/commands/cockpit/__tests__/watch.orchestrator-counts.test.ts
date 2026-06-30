import { beforeEach, describe, expect, it } from 'vitest';
import type {
  JobsResult,
  OrchestratorClient,
  WorkersResult,
} from '@generacy-ai/cockpit';
import {
  pollOrchestratorCounts,
  OrchestratorCountsEventSchema,
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

function client(opts: {
  jobs?: JobsResult;
  workers?: WorkersResult;
  delayMs?: number;
}): OrchestratorClient {
  return {
    isAvailable: () => true,
    health: async () => ({ available: false, reason: 'no-token' }),
    getJobs: async () => {
      if (opts.delayMs != null) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      return opts.jobs ?? { available: true, jobs: [] };
    },
    getWorkers: async () => {
      if (opts.delayMs != null) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      return opts.workers ?? { available: true, count: 0 };
    },
  };
}

describe('pollOrchestratorCounts — state machine', () => {
  let sink: CaptureSink;

  beforeEach(() => {
    sink = new CaptureSink();
  });

  it('baseline (prev=null) when available → emits available event; curr matches', async () => {
    const c = client({
      jobs: {
        available: true,
        jobs: [
          { id: 'j1', status: 'queued' },
          { id: 'j2', status: 'running' },
        ],
      },
      workers: { available: true, count: 3 },
    });
    const warner = createFirstFailureWarner(sink);

    const result = await pollOrchestratorCounts(c, null, warner);

    expect(result.event).toEqual({
      type: 'orchestrator-counts',
      jobs: 2,
      workers: 3,
    });
    expect(result.curr).toEqual({ kind: 'available', jobs: 2, workers: 3 });
    expect(warner.hasFired()).toBe(false);
  });

  it('baseline (prev=null) when unavailable → emits unavailable event with reason', async () => {
    const c = client({
      jobs: { available: false, reason: 'cloud-unreachable' },
      workers: { available: true, count: 0 },
    });
    const warner = createFirstFailureWarner(sink);

    const result = await pollOrchestratorCounts(c, null, warner);

    expect(result.event).toEqual({
      type: 'orchestrator-counts',
      available: false,
      reason: 'cloud-unreachable',
    });
    expect(result.curr).toEqual({
      kind: 'unavailable',
      reason: 'cloud-unreachable',
    });
  });

  it('available→available same counts → null event', async () => {
    const c = client({
      jobs: { available: true, jobs: [{ id: 'j1', status: 'queued' }] },
      workers: { available: true, count: 2 },
    });
    const warner = createFirstFailureWarner(sink);
    const prev: OrchestratorCountsState = {
      kind: 'available',
      jobs: 1,
      workers: 2,
    };

    const result = await pollOrchestratorCounts(c, prev, warner);

    expect(result.event).toBeNull();
    expect(result.curr).toEqual({ kind: 'available', jobs: 1, workers: 2 });
  });

  it('available→available jobs changed → emits', async () => {
    const c = client({
      jobs: {
        available: true,
        jobs: [
          { id: 'j1', status: 'queued' },
          { id: 'j2', status: 'queued' },
          { id: 'j3', status: 'queued' },
        ],
      },
      workers: { available: true, count: 2 },
    });
    const warner = createFirstFailureWarner(sink);
    const prev: OrchestratorCountsState = {
      kind: 'available',
      jobs: 1,
      workers: 2,
    };

    const result = await pollOrchestratorCounts(c, prev, warner);

    expect(result.event).toEqual({
      type: 'orchestrator-counts',
      jobs: 3,
      workers: 2,
    });
    expect(result.curr).toEqual({ kind: 'available', jobs: 3, workers: 2 });
  });

  it('available→available workers changed → emits', async () => {
    const c = client({
      jobs: { available: true, jobs: [{ id: 'j1', status: 'queued' }] },
      workers: { available: true, count: 5 },
    });
    const warner = createFirstFailureWarner(sink);
    const prev: OrchestratorCountsState = {
      kind: 'available',
      jobs: 1,
      workers: 2,
    };

    const result = await pollOrchestratorCounts(c, prev, warner);

    expect(result.event).toEqual({
      type: 'orchestrator-counts',
      jobs: 1,
      workers: 5,
    });
    expect(result.curr).toEqual({ kind: 'available', jobs: 1, workers: 5 });
  });

  it('available→unavailable → emits unavailable event', async () => {
    const c = client({
      jobs: { available: false, reason: 'http-error', statusCode: 500 },
      workers: { available: true, count: 2 },
    });
    const warner = createFirstFailureWarner(sink);
    const prev: OrchestratorCountsState = {
      kind: 'available',
      jobs: 1,
      workers: 2,
    };

    const result = await pollOrchestratorCounts(c, prev, warner);

    expect(result.event).toEqual({
      type: 'orchestrator-counts',
      available: false,
      reason: 'http-error',
    });
    expect(result.curr).toEqual({
      kind: 'unavailable',
      reason: 'http-error',
    });
    expect(warner.hasFired()).toBe(true);
  });

  it('unavailable→unavailable same reason → null event', async () => {
    const c = client({
      jobs: { available: false, reason: 'cloud-unreachable' },
      workers: { available: true, count: 0 },
    });
    const warner = createFirstFailureWarner(sink);
    // Mark warner as already fired so we are testing only the emit-decision
    warner('cloud-unreachable');
    const prev: OrchestratorCountsState = {
      kind: 'unavailable',
      reason: 'cloud-unreachable',
    };

    const result = await pollOrchestratorCounts(c, prev, warner);

    expect(result.event).toBeNull();
    expect(result.curr).toEqual({
      kind: 'unavailable',
      reason: 'cloud-unreachable',
    });
  });

  it('unavailable→unavailable different reason → emits', async () => {
    const c = client({
      jobs: { available: false, reason: 'http-error', statusCode: 503 },
      workers: { available: true, count: 0 },
    });
    const warner = createFirstFailureWarner(sink);
    const prev: OrchestratorCountsState = {
      kind: 'unavailable',
      reason: 'cloud-unreachable',
    };

    const result = await pollOrchestratorCounts(c, prev, warner);

    expect(result.event).toEqual({
      type: 'orchestrator-counts',
      available: false,
      reason: 'http-error',
    });
    expect(result.curr).toEqual({
      kind: 'unavailable',
      reason: 'http-error',
    });
  });

  it('unavailable→available → emits available event', async () => {
    const c = client({
      jobs: {
        available: true,
        jobs: [{ id: 'j1', status: 'queued' }],
      },
      workers: { available: true, count: 4 },
    });
    const warner = createFirstFailureWarner(sink);
    const prev: OrchestratorCountsState = {
      kind: 'unavailable',
      reason: 'cloud-unreachable',
    };

    const result = await pollOrchestratorCounts(c, prev, warner);

    expect(result.event).toEqual({
      type: 'orchestrator-counts',
      jobs: 1,
      workers: 4,
    });
    expect(result.curr).toEqual({ kind: 'available', jobs: 1, workers: 4 });
  });
});

describe('pollOrchestratorCounts — timeout', () => {
  it('timeout → curr {kind: unavailable, reason: timeout}', async () => {
    const sink = new CaptureSink();
    const c = client({ delayMs: 200 });
    const warner = createFirstFailureWarner(sink);

    const result = await pollOrchestratorCounts(c, null, warner, 50);

    expect(result.curr).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(result.event).toEqual({
      type: 'orchestrator-counts',
      available: false,
      reason: 'timeout',
    });
    expect(warner.hasFired()).toBe(true);
    expect(sink.messages).toEqual([
      'cockpit: orchestrator unavailable: timeout\n',
    ]);
  });
});

describe('pollOrchestratorCounts — NDJSON byte stability', () => {
  it('stringified available event matches the exact contract C shape', async () => {
    const sink = new CaptureSink();
    const c = client({
      jobs: {
        available: true,
        jobs: [
          { id: 'j1', status: 'queued' },
          { id: 'j2', status: 'running' },
          { id: 'j3', status: 'completed' },
        ],
      },
      workers: { available: true, count: 4 },
    });
    const warner = createFirstFailureWarner(sink);

    const result = await pollOrchestratorCounts(c, null, warner);

    expect(result.event).not.toBeNull();
    expect(JSON.stringify(result.event)).toBe(
      '{"type":"orchestrator-counts","jobs":3,"workers":4}',
    );
  });

  it('stringified unavailable event matches the exact contract C shape', async () => {
    const sink = new CaptureSink();
    const c = client({
      jobs: { available: false, reason: 'cloud-unreachable' },
      workers: { available: true, count: 0 },
    });
    const warner = createFirstFailureWarner(sink);

    const result = await pollOrchestratorCounts(c, null, warner);

    expect(result.event).not.toBeNull();
    expect(JSON.stringify(result.event)).toBe(
      '{"type":"orchestrator-counts","available":false,"reason":"cloud-unreachable"}',
    );
  });

  it('OrchestratorCountsEventSchema accepts both branches', () => {
    expect(
      OrchestratorCountsEventSchema.parse({
        type: 'orchestrator-counts',
        jobs: 0,
        workers: 0,
      }),
    ).toEqual({ type: 'orchestrator-counts', jobs: 0, workers: 0 });

    expect(
      OrchestratorCountsEventSchema.parse({
        type: 'orchestrator-counts',
        available: false,
        reason: 'timeout',
      }),
    ).toEqual({
      type: 'orchestrator-counts',
      available: false,
      reason: 'timeout',
    });
  });

  it('OrchestratorCountsEventSchema rejects negative or non-int counts', () => {
    expect(() =>
      OrchestratorCountsEventSchema.parse({
        type: 'orchestrator-counts',
        jobs: -1,
        workers: 0,
      }),
    ).toThrow();
    expect(() =>
      OrchestratorCountsEventSchema.parse({
        type: 'orchestrator-counts',
        jobs: 1.5,
        workers: 0,
      }),
    ).toThrow();
  });

  it('OrchestratorCountsEventSchema rejects wrong type literal', () => {
    expect(() =>
      OrchestratorCountsEventSchema.parse({
        type: 'something-else',
        jobs: 0,
        workers: 0,
      }),
    ).toThrow();
  });
});

describe('pollOrchestratorCounts — onFirstFailure side effect', () => {
  it('calls onFirstFailure once for the first unavailable result', async () => {
    const sink = new CaptureSink();
    const c = client({
      jobs: { available: false, reason: 'cloud-unreachable' },
      workers: { available: true, count: 0 },
    });
    const warner = createFirstFailureWarner(sink);

    await pollOrchestratorCounts(c, null, warner);

    expect(warner.hasFired()).toBe(true);
    expect(sink.messages).toEqual([
      'cockpit: orchestrator unavailable: cloud-unreachable\n',
    ]);
  });

  it('does NOT call onFirstFailure for no-token reason', async () => {
    const sink = new CaptureSink();
    const c = client({
      jobs: { available: false, reason: 'no-token' },
      workers: { available: false, reason: 'no-token' },
    });
    const warner = createFirstFailureWarner(sink);

    await pollOrchestratorCounts(c, null, warner);

    expect(warner.hasFired()).toBe(false);
    expect(sink.messages).toHaveLength(0);
  });

  it('does NOT write a second line on subsequent unavailable ticks (warner self-limits)', async () => {
    const sink = new CaptureSink();
    const c = client({
      jobs: { available: false, reason: 'cloud-unreachable' },
      workers: { available: true, count: 0 },
    });
    const warner = createFirstFailureWarner(sink);

    let prev: OrchestratorCountsState | null = null;
    for (let i = 0; i < 5; i++) {
      const result = await pollOrchestratorCounts(c, prev, warner);
      prev = result.curr;
    }

    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]).toBe(
      'cockpit: orchestrator unavailable: cloud-unreachable\n',
    );
  });
});
