import { describe, expect, it } from 'vitest';
import type {
  JobsResult,
  OrchestratorClient,
  WorkersResult,
} from '@generacy-ai/cockpit';
import { getFooter, renderFooter } from '../shared/orchestrator-footer.js';

function client(opts: {
  jobs?: JobsResult;
  workers?: WorkersResult;
  delayMs?: number;
  available?: boolean;
}): OrchestratorClient {
  return {
    isAvailable: () => opts.available ?? true,
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
      return opts.workers ?? { available: true, workers: [] };
    },
  };
}

describe('getFooter', () => {
  it('returns counts when both available', async () => {
    const c = client({
      jobs: { available: true, jobs: [{ id: 'j1', status: 'queued' }, { id: 'j2', status: 'running' }] },
      workers: { available: true, workers: [{ id: 'w1', status: 'idle' }] },
    });
    const footer = await getFooter(c, 1000);
    expect(footer).toEqual({ available: true, jobs: 2, workers: 1 });
  });

  it('returns unavailable + reason when jobs is unavailable', async () => {
    const c = client({
      jobs: { available: false, reason: 'no-token' },
      workers: { available: true, workers: [] },
    });
    const footer = await getFooter(c);
    expect(footer.available).toBe(false);
    expect(footer.reason).toBe('no-token');
  });

  it('returns timeout when the call exceeds timeoutMs', async () => {
    const c = client({ delayMs: 200 });
    const footer = await getFooter(c, 50);
    expect(footer).toEqual({ available: false, reason: 'timeout' });
  });
});

describe('renderFooter', () => {
  it('renders the happy path with job + worker counts', () => {
    expect(renderFooter({ available: true, jobs: 3, workers: 2 })).toBe(
      'orchestrator: 3 jobs, 2 workers',
    );
  });

  it('renders stub-mode (no-token) as a hint', () => {
    expect(renderFooter({ available: false, reason: 'no-token' })).toBe(
      'orchestrator: (no token; set ORCHESTRATOR_API_TOKEN to enable)',
    );
  });

  it('renders timeout as "(unavailable — timeout)"', () => {
    expect(renderFooter({ available: false, reason: 'timeout' })).toBe(
      'orchestrator: (unavailable — timeout)',
    );
  });
});
