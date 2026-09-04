import { describe, expect, it, vi } from 'vitest';
import {
  GhCliWrapper,
  createGhResponseCache,
  createRateLimitScheduler,
  type CommandRunner,
} from '@generacy-ai/cockpit';
import { runOnePoll } from '../watch/poll-loop.js';
import type { SnapshotMap } from '../watch/snapshot.js';

const CHECK_RUNS = JSON.stringify([
  { name: 'ci', state: 'SUCCESS' },
  { name: 'build', state: 'SUCCESS' },
]);
const PR_VIEW = JSON.stringify({
  number: 1,
  state: 'OPEN',
  url: 'https://github.com/o/r/pull/1',
  isDraft: false,
  labels: [],
  headRefOid: 'sha-a',
});

interface Counters {
  prChecks: number;
  prView: number;
  issueView: number;
  searchIssues: number;
  apiGraphqlLookup: number;
}

function scriptedRunner(): { runner: CommandRunner; counters: Counters } {
  const counters: Counters = {
    prChecks: 0,
    prView: 0,
    issueView: 0,
    searchIssues: 0,
    apiGraphqlLookup: 0,
  };
  const runner: CommandRunner = vi.fn(async (_cmd, args) => {
    if (args[0] === 'pr' && args[1] === 'checks') {
      counters.prChecks += 1;
      return { stdout: CHECK_RUNS, stderr: '', exitCode: 0 };
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      counters.prView += 1;
      return { stdout: PR_VIEW, stderr: '', exitCode: 0 };
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      counters.issueView += 1;
      return { stdout: '{}', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      const queryArg = args.find((a) => a.startsWith('query=')) ?? '';
      if (queryArg.includes('CockpitBatchLookup')) {
        counters.apiGraphqlLookup += 1;
        // Exact-lookup returns 4 open PRs as aliased issueOrPullRequest nodes.
        const nodes: Record<string, unknown> = {};
        [1, 2, 3, 4].forEach((n, i) => {
          nodes[`r${i}`] = {
            __typename: 'PullRequest',
            number: n,
            title: `PR ${n}`,
            url: `https://github.com/o/r/pull/${n}`,
            state: 'OPEN',
            body: '',
            createdAt: '',
            author: null,
            labels: { nodes: [] },
          };
        });
        return {
          stdout: JSON.stringify({ data: { repository: nodes } }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'search' && args[1] === 'issues') {
      counters.searchIssues += 1;
      return { stdout: '[]', stderr: '', exitCode: 0 };
    }
    return { stdout: '[]', stderr: '', exitCode: 0 };
  });
  return { runner, counters };
}

async function drivePolls(
  gh: GhCliWrapper,
  cycles: number,
): Promise<void> {
  let prev: SnapshotMap = new Map();
  for (let i = 0; i < cycles; i++) {
    const result = await runOnePoll(prev, {
      gh,
      refs: [
        { repo: 'o/r', number: 1 },
        { repo: 'o/r', number: 2 },
        { repo: 'o/r', number: 3 },
        { repo: 'o/r', number: 4 },
      ],
    });
    prev = result.curr;
  }
}

describe('cockpit graphql budget integration', () => {
  it('regression witness — unconditional check-runs API (no gate) would issue N*cycles calls', async () => {
    const { runner, counters } = scriptedRunner();
    const gh = new GhCliWrapper(runner);
    // Prove out the unmitigated cost: call getPullRequestCheckRuns for 4 PRs
    // once per cycle for 120 cycles. This is what the poll loop would do
    // without the derivePrChecksNeeded gate.
    for (let cycle = 0; cycle < 120; cycle++) {
      for (const pr of [1, 2, 3, 4]) {
        await gh.getPullRequestCheckRuns('o/r', pr);
      }
    }
    expect(counters.prChecks).toBe(480);
  });

  it('cache+gate ENABLED: check-runs gated by lifecycle + safety cycle', async () => {
    const { runner, counters } = scriptedRunner();
    const cache = createGhResponseCache({ ttlMs: 20_000 });
    const gh = new GhCliWrapper(runner, undefined, { cache });
    await drivePolls(gh, 120);
    // Cycle 1: 4 fetches (no prev).
    // Cycles 2-20: skip-terminal (checks were SUCCESS).
    // Cycle 21: safety-cycle → 4 fetches. Reset counter.
    // Cycles 22-41: skip. Cycle 42: 4 fetches. …
    // 120 cycles: fetches at cycles 1, 21, 41, 61, 81, 101 → 6 batches × 4 = 24 calls.
    expect(counters.prChecks).toBeLessThanOrEqual(30);
    // First-observation getPullRequest for headRefOid: 4 fetches at cycle 1.
    // No further fetches in steady state.
    expect(counters.prView).toBeLessThanOrEqual(6);
    // #1229 — exactly one aliased-graphql lookup per repo per cycle (1 repo).
    expect(counters.apiGraphqlLookup).toBe(120);
    // #1229 — the poll path never issues a free-text `gh search issues`.
    expect(counters.searchIssues).toBe(0);
  });

  it('scheduler widens when GraphQL budget drops below 20%', async () => {
    const runner: CommandRunner = vi.fn(async () => ({
      stdout: JSON.stringify({
        resources: {
          graphql: { remaining: 500, limit: 5000, reset: 0 },
        },
      }),
      stderr: '',
      exitCode: 0,
    }));
    const scheduler = createRateLimitScheduler({ runner });
    const probe = await scheduler.probeNow();
    expect(probe?.remaining).toBe(500);
    expect(scheduler.getCurrentIntervalMs()).toBe(60_000);
  });
});
