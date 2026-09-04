import { describe, expect, it, vi } from 'vitest';
import { GhCliWrapper } from '../wrapper.js';
import type { CommandResult, CommandRunner } from '../command-runner.js';

interface Call {
  cmd: string;
  args: string[];
}

function stubRunner(replies: Array<Partial<CommandResult>>): {
  runner: CommandRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  let idx = 0;
  const runner: CommandRunner = vi.fn(async (cmd, args) => {
    calls.push({ cmd, args });
    const reply = replies[Math.min(idx, replies.length - 1)] ?? {};
    idx += 1;
    return {
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      exitCode: reply.exitCode ?? 0,
    };
  });
  return { runner, calls };
}

function envelope(nodes: Record<string, unknown>): string {
  return JSON.stringify({ data: { repository: nodes } });
}

function issueNode(number: number, extra: Record<string, unknown> = {}) {
  return {
    __typename: 'Issue',
    number,
    title: `Issue ${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    state: 'OPEN',
    stateReason: null,
    body: '',
    createdAt: '',
    author: { login: 'alice' },
    labels: { nodes: [{ name: 'bug' }] },
    ...extra,
  };
}

function prNode(number: number, extra: Record<string, unknown> = {}) {
  return {
    __typename: 'PullRequest',
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    state: 'OPEN',
    body: '',
    createdAt: '',
    author: null,
    labels: { nodes: [] },
    ...extra,
  };
}

describe('batchLookupIssuesOrPrs — query shape', () => {
  it('emits one index-suffixed alias per number with typename inline fragments', async () => {
    const { runner, calls } = stubRunner([
      { stdout: envelope({ r0: issueNode(1), r1: prNode(2) }) },
    ]);
    const wrapper = new GhCliWrapper(runner);
    await wrapper.batchLookupIssuesOrPrs('o/r', [1, 2]);

    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    expect(args[0]).toBe('api');
    expect(args[1]).toBe('graphql');
    expect(args).toContain('owner=o');
    expect(args).toContain('repo=r');
    const queryArg = args.find((a) => a.startsWith('query='))!;
    expect(queryArg).toContain('r0: issueOrPullRequest(number: 1)');
    expect(queryArg).toContain('r1: issueOrPullRequest(number: 2)');
    expect(queryArg).toContain('__typename');
    expect(queryArg).toContain('... on Issue');
    expect(queryArg).toContain('... on PullRequest');
  });
});

describe('batchLookupIssuesOrPrs — mapping', () => {
  it('maps an issue node, a null author omission, and labels', async () => {
    const { runner } = stubRunner([{ stdout: envelope({ r0: issueNode(1) }) }]);
    const wrapper = new GhCliWrapper(runner);
    const [issue] = await wrapper.batchLookupIssuesOrPrs('o/r', [1]);
    expect(issue).toMatchObject({
      number: 1,
      state: 'OPEN',
      stateReason: null,
      labels: ['bug'],
      author: { login: 'alice' },
    });
  });

  it('maps an open PR and a merged PR (MERGED → CLOSED, stateReason null)', async () => {
    const { runner } = stubRunner([
      {
        stdout: envelope({
          r0: prNode(2, { state: 'OPEN' }),
          r1: prNode(3, { state: 'MERGED' }),
        }),
      },
    ]);
    const wrapper = new GhCliWrapper(runner);
    const result = await wrapper.batchLookupIssuesOrPrs('o/r', [2, 3]);
    const open = result.find((i) => i.number === 2)!;
    const merged = result.find((i) => i.number === 3)!;
    expect(open.state).toBe('OPEN');
    expect(merged.state).toBe('CLOSED');
    expect(merged.stateReason).toBeNull();
    expect(open.author).toBeUndefined();
  });

  it('skips null aliases (stale refs) without emitting an Issue', async () => {
    const { runner } = stubRunner([
      { stdout: envelope({ r0: issueNode(1), r1: null }) },
    ]);
    const wrapper = new GhCliWrapper(runner);
    const result = await wrapper.batchLookupIssuesOrPrs('o/r', [1, 2]);
    expect(result).toHaveLength(1);
    expect(result[0]!.number).toBe(1);
  });
});

describe('batchLookupIssuesOrPrs — error tolerance', () => {
  it('tolerates a non-zero exit when every error is NOT_FOUND, keeping partial data', async () => {
    const { runner } = stubRunner([
      {
        stdout: JSON.stringify({
          data: { repository: { r0: issueNode(1), r1: null } },
          errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }],
        }),
        stderr: 'graphql error',
        exitCode: 1,
      },
    ]);
    const wrapper = new GhCliWrapper(runner);
    const result = await wrapper.batchLookupIssuesOrPrs('o/r', [1, 2]);
    expect(result).toHaveLength(1);
    expect(result[0]!.number).toBe(1);
  });

  it('throws when a non-zero exit carries a non-NOT_FOUND error', async () => {
    const { runner } = stubRunner([
      {
        stdout: JSON.stringify({
          data: { repository: {} },
          errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
        }),
        stderr: 'rate limited',
        exitCode: 1,
      },
    ]);
    const wrapper = new GhCliWrapper(runner);
    await expect(wrapper.batchLookupIssuesOrPrs('o/r', [1])).rejects.toThrow();
  });
});

describe('batchLookupIssuesOrPrs — chunking & empty input', () => {
  it('makes zero subprocess calls for empty input', async () => {
    const { runner, calls } = stubRunner([{ stdout: envelope({}) }]);
    const wrapper = new GhCliWrapper(runner);
    const result = await wrapper.batchLookupIssuesOrPrs('o/r', []);
    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('chunks >100 numbers into separate calls and concatenates results', async () => {
    const numbers = Array.from({ length: 150 }, (_, i) => i + 1);
    const chunk1 = Object.fromEntries(
      numbers.slice(0, 100).map((n, i) => [`r${i}`, issueNode(n)]),
    );
    const chunk2 = Object.fromEntries(
      numbers.slice(100).map((n, i) => [`r${i}`, issueNode(n)]),
    );
    const { runner, calls } = stubRunner([
      { stdout: envelope(chunk1) },
      { stdout: envelope(chunk2) },
    ]);
    const wrapper = new GhCliWrapper(runner);
    const result = await wrapper.batchLookupIssuesOrPrs('o/r', numbers);
    expect(calls).toHaveLength(2);
    expect(result).toHaveLength(150);
  });
});
