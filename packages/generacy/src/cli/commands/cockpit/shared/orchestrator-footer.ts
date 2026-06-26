import type { OrchestratorClient } from '@generacy-ai/cockpit';

export interface FooterData {
  available: boolean;
  reason?: string;
  jobs?: number;
  workers?: number;
}

const DEFAULT_TIMEOUT_MS = 1500;

function timeout<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => {
    setTimeout(() => resolve(value), ms).unref?.();
  });
}

/**
 * Race the orchestrator client's `getJobs()` + `getWorkers()` against a timeout.
 * Never throws. Always returns a FooterData; on any failure → `{ available: false, reason }`.
 */
export async function getFooter(
  client: OrchestratorClient,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<FooterData> {
  try {
    const sentinel = Symbol('timeout');
    const races = await Promise.all([
      Promise.race([client.getJobs(), timeout(timeoutMs, sentinel)]),
      Promise.race([client.getWorkers(), timeout(timeoutMs, sentinel)]),
    ]);
    const [jobsResult, workersResult] = races;
    if (jobsResult === sentinel || workersResult === sentinel) {
      return { available: false, reason: 'timeout' };
    }
    if (!jobsResult.available) {
      return { available: false, reason: jobsResult.reason };
    }
    if (!workersResult.available) {
      return { available: false, reason: workersResult.reason };
    }
    return {
      available: true,
      jobs: jobsResult.jobs.length,
      workers: workersResult.workers.length,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { available: false, reason: msg.length > 0 ? msg : 'unknown' };
  }
}

export function renderFooter(footer: FooterData): string {
  if (footer.available) {
    return `orchestrator: ${footer.jobs ?? 0} jobs, ${footer.workers ?? 0} workers`;
  }
  if (footer.reason === 'no-token') {
    return 'orchestrator: (no token; set ORCHESTRATOR_API_TOKEN to enable)';
  }
  return `orchestrator: (unavailable — ${footer.reason ?? 'unknown'})`;
}
