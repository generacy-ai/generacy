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
export type CiWaitOutcome = {
  kind: 'green' | 'not-passed' | 'timeout';
  /**
   * The aggregated verdict behind `kind` (`pending` on `timeout`). Surfaced so
   * the pause comment can report the REAL verdict rather than a canned reason.
   */
  verdict: CiVerdict;
  /**
   * Which readout produced the verdict. `undefined` only when every readout
   * threw before the wait window elapsed (timeout with no successful poll).
   */
  source?: CiReadiness['source'];
};

export interface EvaluateCiReadinessParams {
  github: GitHubClient;
  owner: string;
  repo: string;
  headSha: string;
  branch: string;
  logger?: Logger;
}

/**
 * Read the CI runs for a head SHA and aggregate them into a three-state
 * verdict. Never declares green on `pending` (FR-004). A thrown readout
 * propagates — `waitForCiGreen` treats it as transient.
 *
 * Source trust: the `actions/runs` fallback (used when the primary
 * `check-runs` readout fails — typically a token lacking `checks:read`) only
 * enumerates GitHub-Actions workflow runs for the branch and is blind to
 * third-party required checks (external status contexts). A `green` aggregated
 * from it is TRUSTED — the blind spot is a documented limitation, logged at
 * `warn` — because failing it closed (the #1157 FR-007 downgrade) made every
 * validate on such a token pause with a "CI is red" reason while CI was green,
 * leaving the merge gate unusable.
 */
export async function evaluateCiReadiness(
  params: EvaluateCiReadinessParams,
): Promise<CiReadiness> {
  const { github, owner, repo, headSha, branch, logger } = params;
  const { runs, source } = await github.getCiRunsForSha(
    owner,
    repo,
    headSha,
    branch,
  );
  const verdict = aggregateCiVerdict(runs);
  if (source === 'actions-runs' && verdict === 'green') {
    logger?.warn(
      { owner, repo, headSha, runCount: runs.length },
      'CI green sourced from the actions/runs fallback (check-runs unavailable — ' +
        'token likely lacks checks:read); third-party required checks are not ' +
        'visible to this readout. Trusting green.',
    );
  }
  return {
    verdict,
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
  let lastSource: CiReadiness['source'] | undefined;

  for (;;) {
    try {
      const readiness = await evaluateCiReadiness({ ...readinessParams, logger });
      lastSource = readiness.source;
      if (readiness.verdict === 'green') {
        return { kind: 'green', verdict: 'green', source: readiness.source };
      }
      if (readiness.verdict === 'not-passed') {
        return { kind: 'not-passed', verdict: 'not-passed', source: readiness.source };
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
      return { kind: 'timeout', verdict: 'pending', source: lastSource };
    }

    const delay = Math.min(backoffForAttempt(attempt), ciWaitTimeoutMs - elapsed);
    attempt += 1;
    await sleep(delay);
  }
}
