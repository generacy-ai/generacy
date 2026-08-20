import type { CiVerdict, GitHubClient } from '@generacy-ai/workflow-engine';
import { aggregateCiVerdict } from '@generacy-ai/workflow-engine';
import type { Logger } from './types.js';

/**
 * Snapshot of CI merge-readiness for a single head SHA (#1133 US2).
 */
export interface CiReadiness {
  verdict: CiVerdict;
  runCount: number;
  source: 'check-runs' | 'actions-runs';
}

/**
 * Terminal outcome of `waitForCiGreen`. `timeout` means the wait window elapsed
 * while CI was still `pending` — the caller pauses with `waiting-for:ci`
 * (Q1-C / FR-004) rather than declaring green.
 */
export type CiWaitOutcome = { kind: 'green' | 'not-passed' | 'timeout' };

export interface EvaluateCiReadinessParams {
  github: GitHubClient;
  owner: string;
  repo: string;
  headSha: string;
  branch: string;
}

/**
 * Read the CI runs for a head SHA and aggregate them into a three-state
 * verdict. Never declares green on `pending` (FR-004). A thrown readout
 * propagates — `waitForCiGreen` treats it as transient.
 */
export async function evaluateCiReadiness(
  params: EvaluateCiReadinessParams,
): Promise<CiReadiness> {
  const { github, owner, repo, headSha, branch } = params;
  const { runs, source } = await github.getCiRunsForSha(
    owner,
    repo,
    headSha,
    branch,
  );
  return {
    verdict: aggregateCiVerdict(runs),
    runCount: runs.length,
    source,
  };
}

/** Backoff schedule (ms): 5s → 10s → 20s → cap 30s (SC-005, no busy loop). */
const BACKOFF_SCHEDULE_MS = [5_000, 10_000, 20_000];
const BACKOFF_CAP_MS = 30_000;

function backoffForAttempt(attempt: number): number {
  return BACKOFF_SCHEDULE_MS[attempt] ?? BACKOFF_CAP_MS;
}

export interface WaitForCiGreenParams extends EvaluateCiReadinessParams {
  ciWaitTimeoutMs: number;
  /** Injectable sleep for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
  logger?: Logger;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll CI readiness with bounded exponential backoff until the verdict resolves
 * to `green` or `not-passed`, or the elapsed time reaches `ciWaitTimeoutMs`
 * (→ `timeout`). A thrown readout is transient — log and continue backing off
 * until the ceiling. Never declares green on a `pending` verdict (FR-004).
 */
export async function waitForCiGreen(
  params: WaitForCiGreenParams,
): Promise<CiWaitOutcome> {
  const {
    ciWaitTimeoutMs,
    sleep = defaultSleep,
    now = Date.now,
    logger,
    ...readinessParams
  } = params;

  const start = now();
  let attempt = 0;

  for (;;) {
    try {
      const readiness = await evaluateCiReadiness(readinessParams);
      if (readiness.verdict === 'green') {
        return { kind: 'green' };
      }
      if (readiness.verdict === 'not-passed') {
        return { kind: 'not-passed' };
      }
      // pending → keep waiting
    } catch (err) {
      logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'CI readout failed; treating as transient and continuing backoff',
      );
    }

    const elapsed = now() - start;
    if (elapsed >= ciWaitTimeoutMs) {
      return { kind: 'timeout' };
    }

    const delay = Math.min(backoffForAttempt(attempt), ciWaitTimeoutMs - elapsed);
    attempt += 1;
    await sleep(delay);
  }
}
