/**
 * Unit tests for ci-merge-readiness (#1133 T007/T008).
 *
 * Covers:
 *   - evaluateCiReadiness maps runs through aggregateCiVerdict
 *   - waitForCiGreen bounded backoff (no busy loop, SC-005)
 *   - pending → timeout outcome
 *   - green short-circuit
 *   - not-passed outcome
 *   - thrown-readout-then-recover continues backoff
 */
import { describe, it, expect, vi } from 'vitest';
import type { CiRun, GitHubClient } from '@generacy-ai/workflow-engine';
import {
  evaluateCiReadiness,
  waitForCiGreen,
} from '../ci-merge-readiness.js';

function githubReturning(
  results: Array<{ runs: CiRun[]; source?: 'check-runs' | 'actions-runs' } | Error>,
): { github: GitHubClient; calls: () => number } {
  let i = 0;
  const getCiRunsForSha = vi.fn(async () => {
    const r = results[Math.min(i, results.length - 1)]!;
    i += 1;
    if (r instanceof Error) throw r;
    return { runs: r.runs, source: r.source ?? 'check-runs' };
  });
  const github = { getCiRunsForSha } as unknown as GitHubClient;
  return { github, calls: () => getCiRunsForSha.mock.calls.length };
}

const baseParams = {
  owner: 'o',
  repo: 'r',
  headSha: 'sha123',
  branch: 'feature',
};

describe('evaluateCiReadiness', () => {
  it('maps runs through aggregateCiVerdict and reports runCount + source', async () => {
    const { github } = githubReturning([
      {
        runs: [{ status: 'completed', conclusion: 'success' }],
        source: 'actions-runs',
      },
    ]);
    const readiness = await evaluateCiReadiness({ github, ...baseParams });
    expect(readiness.verdict).toBe('green');
    expect(readiness.runCount).toBe(1);
    expect(readiness.source).toBe('actions-runs');
  });
});

describe('waitForCiGreen', () => {
  it('green short-circuits on first poll (no sleep)', async () => {
    const { github, calls } = githubReturning([
      { runs: [{ status: 'completed', conclusion: 'success' }] },
    ]);
    const sleep = vi.fn(async () => {});
    const outcome = await waitForCiGreen({
      github,
      ...baseParams,
      ciWaitTimeoutMs: 900_000,
      sleep,
      now: () => 0,
    });
    expect(outcome).toEqual({ kind: 'green' });
    expect(calls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('returns not-passed on a failing verdict', async () => {
    const { github } = githubReturning([
      { runs: [{ status: 'completed', conclusion: 'failure' }] },
    ]);
    const outcome = await waitForCiGreen({
      github,
      ...baseParams,
      ciWaitTimeoutMs: 900_000,
      sleep: vi.fn(async () => {}),
      now: () => 0,
    });
    expect(outcome).toEqual({ kind: 'not-passed' });
  });

  it('pending → timeout after the wait window with bounded backoff (SC-005)', async () => {
    // Always pending. Clock advances by the requested sleep each call.
    const { github, calls } = githubReturning([{ runs: [] }]);
    let clock = 0;
    const slept: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      slept.push(ms);
      clock += ms;
    });
    const outcome = await waitForCiGreen({
      github,
      ...baseParams,
      ciWaitTimeoutMs: 60_000,
      sleep,
      now: () => clock,
    });
    expect(outcome).toEqual({ kind: 'timeout' });
    // Bounded, increasing backoff capped at 30s; last delay clamped to remaining.
    expect(slept[0]).toBe(5_000);
    expect(slept[1]).toBe(10_000);
    expect(slept[2]).toBe(20_000);
    // No busy loop: a finite, small number of polls covers the window.
    expect(calls()).toBeLessThan(10);
    // Never slept past the timeout budget.
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000);
  });

  it('a thrown readout is transient — continues backoff then resolves', async () => {
    const { github, calls } = githubReturning([
      new Error('gh boom'),
      { runs: [{ status: 'completed', conclusion: 'success' }] },
    ]);
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const outcome = await waitForCiGreen({
      github,
      ...baseParams,
      ciWaitTimeoutMs: 900_000,
      sleep,
      now: () => clock,
    });
    expect(outcome).toEqual({ kind: 'green' });
    expect(calls()).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
