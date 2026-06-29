import type { OrchestratorClient } from '@generacy-ai/cockpit';
import type { FirstFailureWarner } from './orchestrator-warn.js';

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
 *
 * If `onFirstFailure` is provided, it is invoked once per failure (the warner
 * itself dedupes across calls). It is NOT invoked when the failure reason is
 * `'no-token'` — that state is already explicit in the rendered output and is
 * not a runtime failure.
 */
export async function getFooter(
  client: OrchestratorClient,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  onFirstFailure?: FirstFailureWarner,
): Promise<FooterData> {
  try {
    const sentinel = Symbol('timeout');
    const races = await Promise.all([
      Promise.race([client.getJobs(), timeout(timeoutMs, sentinel)]),
      Promise.race([client.getWorkers(), timeout(timeoutMs, sentinel)]),
    ]);
    const [jobsResult, workersResult] = races;
    if (jobsResult === sentinel || workersResult === sentinel) {
      onFirstFailure?.('timeout');
      return { available: false, reason: 'timeout' };
    }
    if (!jobsResult.available) {
      if (jobsResult.reason !== 'no-token') {
        onFirstFailure?.(jobsResult.reason);
      }
      return { available: false, reason: jobsResult.reason };
    }
    if (!workersResult.available) {
      if (workersResult.reason !== 'no-token') {
        onFirstFailure?.(workersResult.reason);
      }
      return { available: false, reason: workersResult.reason };
    }
    return {
      available: true,
      jobs: jobsResult.jobs.length,
      workers: workersResult.count,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { available: false, reason: msg.length > 0 ? msg : 'unknown' };
  }
}

export function renderFooter(footer: FooterData): string {
  if (footer.available) {
    return `orchestrator: ${footer.jobs ?? 0} jobs, ${footer.workers ?? 0} active workers`;
  }
  if (footer.reason === 'no-token') {
    return 'orchestrator: (no token; set ORCHESTRATOR_API_TOKEN to enable)';
  }
  return `orchestrator: (unavailable — ${footer.reason ?? 'unknown'})`;
}
