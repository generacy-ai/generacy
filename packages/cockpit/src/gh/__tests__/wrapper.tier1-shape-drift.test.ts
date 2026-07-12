import { describe, expect, it, vi } from 'vitest';
import { GhCliWrapper } from '../wrapper.js';
import type { CommandResult, CommandRunner } from '../command-runner.js';

interface QueuedCall {
  cmd: string;
  args: string[];
  ts: number;
}

interface Route {
  match: (cmd: string, args: string[]) => boolean;
  reply: Partial<CommandResult> | (() => Partial<CommandResult>);
}

function routedRunner(routes: Route[]): {
  runner: CommandRunner;
  calls: QueuedCall[];
} {
  const calls: QueuedCall[] = [];
  const runner: CommandRunner = vi.fn(async (cmd, args) => {
    calls.push({ cmd, args, ts: Date.now() });
    for (const r of routes) {
      if (r.match(cmd, args)) {
        const reply = typeof r.reply === 'function' ? r.reply() : r.reply;
        return {
          stdout: reply.stdout ?? '',
          stderr: reply.stderr ?? '',
          exitCode: reply.exitCode ?? 0,
        };
      }
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  return { runner, calls };
}

// Matchers for the three call sites the tier-1 resolver hits.
const isIssueView = (cmd: string, args: string[]): boolean =>
  cmd === 'gh' && args[0] === 'issue' && args[1] === 'view';
const isApiGraphql = (cmd: string, args: string[]): boolean =>
  cmd === 'gh' && args[0] === 'api' && args[1] === 'graphql';
const isGhVersion = (cmd: string, args: string[]): boolean =>
  cmd === 'gh' && args[0] === '--version';
const isPrListSearch = (cmd: string, args: string[]): boolean =>
  cmd === 'gh' && args[0] === 'pr' && args[1] === 'list';

describe('queryTier1ClosingRefs — gh 2.96.0 minimal shape (FR-011, SC-001)', () => {
  it('resolves the PR using the follow-up graphql call when the initial payload lacks state/headRefName', async () => {
    const { runner, calls } = routedRunner([
      {
        match: isIssueView,
        reply: {
          stdout: JSON.stringify({
            closedByPullRequestsReferences: [
              {
                id: 'PR_kwDO',
                number: 912,
                repository: { name: 'y', owner: { login: 'x' } },
                url: 'https://github.com/x/y/pull/912',
              },
            ],
          }),
        },
      },
      {
        match: isApiGraphql,
        reply: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pr0: {
                  number: 912,
                  state: 'OPEN',
                  headRefName: 'feature/foo',
                  isDraft: false,
                  url: 'https://github.com/x/y/pull/912',
                },
              },
            },
          }),
        },
      },
    ]);
    const wrapper = new GhCliWrapper(runner);
    const resolution = await wrapper.resolveIssueToPRRef('x/y', 555);

    expect(resolution).toEqual({
      kind: 'resolved',
      ref: {
        number: 912,
        url: 'https://github.com/x/y/pull/912',
        state: 'OPEN',
        draft: false,
        headRefName: 'feature/foo',
      },
      linkMethod: 'closing-refs',
    });
    // 1 issue view + 1 graphql = exactly 2 calls (tier-2 must not fire).
    expect(calls.filter((c) => isPrListSearch(c.cmd, c.args))).toHaveLength(0);
  });
});

describe('queryTier1ClosingRefs — gh 2.95.x rich shape (SC-002)', () => {
  it('still resolves when the initial payload carries inline state/headRefName (extra fields tolerated via .passthrough())', async () => {
    const { runner } = routedRunner([
      {
        match: isIssueView,
        reply: {
          stdout: JSON.stringify({
            closedByPullRequestsReferences: [
              {
                number: 912,
                url: 'https://github.com/x/y/pull/912',
                state: 'OPEN',
                isDraft: false,
                headRefName: 'feature/foo',
              },
            ],
          }),
        },
      },
      {
        match: isApiGraphql,
        reply: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pr0: {
                  number: 912,
                  state: 'OPEN',
                  headRefName: 'feature/foo',
                  isDraft: false,
                  url: 'https://github.com/x/y/pull/912',
                },
              },
            },
          }),
        },
      },
    ]);
    const wrapper = new GhCliWrapper(runner);
    const resolution = await wrapper.resolveIssueToPRRef('x/y', 555);
    expect(resolution).toMatchObject({
      kind: 'resolved',
      ref: { number: 912, headRefName: 'feature/foo' },
      linkMethod: 'closing-refs',
    });
  });
});

describe('queryTier1ClosingRefs — FR-002a retry-once-then-fail (FR-012c, SC-009)', () => {
  it('retries the graphql call exactly once with ~1s backoff, then throws without falling through to tier-2', async () => {
    const timestamps: number[] = [];
    let graphqlAttempts = 0;
    const { runner, calls } = routedRunner([
      {
        match: isIssueView,
        reply: {
          stdout: JSON.stringify({
            closedByPullRequestsReferences: [
              { number: 100, url: 'https://github.com/x/y/pull/100' },
              { number: 200, url: 'https://github.com/x/y/pull/200' },
            ],
          }),
        },
      },
      {
        match: isApiGraphql,
        reply: () => {
          graphqlAttempts += 1;
          timestamps.push(Date.now());
          return { stdout: '', stderr: 'network error', exitCode: 1 };
        },
      },
      {
        match: isGhVersion,
        reply: { stdout: 'gh version 2.96.0 (2026-07-02)\n' },
      },
    ]);
    const wrapper = new GhCliWrapper(runner);

    await expect(wrapper.resolveIssueToPRRef('x/y', 555)).rejects.toThrow(
      /tier1 follow-up graphql failed after 1 retry/,
    );

    // Exactly two graphql attempts.
    expect(graphqlAttempts).toBe(2);
    // Gap between them: ≥ 990ms, ≤ 1500ms (FR-012c tolerance).
    expect(timestamps.length).toBe(2);
    const gap = timestamps[1]! - timestamps[0]!;
    expect(gap).toBeGreaterThanOrEqual(990);
    expect(gap).toBeLessThanOrEqual(1500);
    // Zero tier-2 calls — never fall through.
    expect(calls.filter((c) => isPrListSearch(c.cmd, c.args))).toHaveLength(0);
  }, 10_000);
});

describe('queryTier1ClosingRefs — FR-009 parse-failure includes gh version (FR-013, SC-005)', () => {
  it('surfaces gh version and payload excerpt when the initial parse fails', async () => {
    const { runner } = routedRunner([
      {
        match: isIssueView,
        reply: { stdout: 'not valid json at all', exitCode: 0 },
      },
      {
        match: isGhVersion,
        reply: { stdout: 'gh version 2.96.0 (2026-07-02)\nhttps://github.com/cli/cli/releases/tag/v2.96.0\n' },
      },
    ]);
    const wrapper = new GhCliWrapper(runner);

    await expect(wrapper.resolveIssueToPRRef('x/y', 555)).rejects.toThrow(
      /gh version: gh version 2\.96\.0/,
    );
    await expect(wrapper.resolveIssueToPRRef('x/y', 555)).rejects.toThrow(
      /payload excerpt:/,
    );
  });

  it('falls back to `gh version: unknown` when `gh --version` exits non-zero (FR-010)', async () => {
    const { runner } = routedRunner([
      {
        match: isIssueView,
        reply: { stdout: 'not valid json', exitCode: 0 },
      },
      {
        match: isGhVersion,
        reply: { stdout: '', stderr: 'not found', exitCode: 127 },
      },
    ]);
    const wrapper = new GhCliWrapper(runner);

    await expect(wrapper.resolveIssueToPRRef('x/y', 555)).rejects.toThrow(
      /gh version: unknown/,
    );
    // FR-010: underlying parse-failure text preserved.
    await expect(wrapper.resolveIssueToPRRef('x/y', 555)).rejects.toThrow(
      /malformed JSON/,
    );
  });
});

describe('queryTier1ClosingRefs — #928 pr-number classification', () => {
  it('returns { kind: "pr-number" } when the initial gh issue view errors with "not an Issue" and the pullRequest classify graphql confirms the PR exists', async () => {
    const isClassifyGraphql = (cmd: string, args: string[]): boolean =>
      isApiGraphql(cmd, args) &&
      // The classify graphql call embeds "CockpitTier1PrClassify" in its query text.
      args.some((a) => a.includes('CockpitTier1PrClassify'));
    const { runner, calls } = routedRunner([
      {
        match: isIssueView,
        reply: {
          stdout: '',
          stderr: 'GraphQL: could not resolve to an Issue with the number of 15',
          exitCode: 1,
        },
      },
      {
        match: isClassifyGraphql,
        reply: {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: { __typename: 'PullRequest' },
              },
            },
          }),
        },
      },
    ]);
    const wrapper = new GhCliWrapper(runner);
    const resolution = await wrapper.resolveIssueToPRRef('x/y', 15);

    expect(resolution).toEqual({ kind: 'pr-number' });
    // Tier-2/3 must NOT fire — invariant I-7.
    expect(calls.filter((c) => isPrListSearch(c.cmd, c.args))).toHaveLength(0);
  });

  it('propagates the original gh issue view error when the pullRequest classify graphql reports no PR either', async () => {
    const isClassifyGraphql = (cmd: string, args: string[]): boolean =>
      isApiGraphql(cmd, args) &&
      args.some((a) => a.includes('CockpitTier1PrClassify'));
    const { runner } = routedRunner([
      {
        match: isIssueView,
        reply: {
          stdout: '',
          stderr: 'GraphQL: could not resolve to an Issue with the number of 999999',
          exitCode: 1,
        },
      },
      {
        match: isClassifyGraphql,
        reply: {
          stdout: JSON.stringify({
            data: { repository: { pullRequest: null } },
          }),
        },
      },
    ]);
    const wrapper = new GhCliWrapper(runner);
    await expect(wrapper.resolveIssueToPRRef('x/y', 999999)).rejects.toThrow(
      /issue view.*failed/,
    );
  });
});

describe('queryTier1ClosingRefs — payload excerpt cap = 512 chars', () => {
  it('trims the malformed-payload excerpt to exactly 512 characters', async () => {
    const bigPayload = 'x'.repeat(10 * 1024); // 10KB of garbage.
    const { runner } = routedRunner([
      {
        match: isIssueView,
        reply: { stdout: bigPayload, exitCode: 0 },
      },
      {
        match: isGhVersion,
        reply: { stdout: 'gh version 2.96.0\n' },
      },
    ]);
    const wrapper = new GhCliWrapper(runner);

    let caught: Error | null = null;
    try {
      await wrapper.resolveIssueToPRRef('x/y', 555);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    const match = caught!.message.match(/payload excerpt: (x+)\)?$/);
    expect(match).not.toBeNull();
    expect(match![1]!.length).toBe(512);
  });
});
