import { describe, expect, it, vi } from 'vitest';
import { GhCliWrapper } from '../wrapper.js';
import type { CommandResult, CommandRunner } from '../command-runner.js';

interface Call {
  cmd: string;
  args: string[];
}

function stubRunner(reply: Partial<CommandResult>): {
  runner: CommandRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const runner: CommandRunner = vi.fn(async (cmd, args) => {
    calls.push({ cmd, args });
    return {
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      exitCode: reply.exitCode ?? 0,
    };
  });
  return { runner, calls };
}

describe('getPullRequestGraphqlDetail — populated closingIssuesReferences', () => {
  it('schema-parses a response with linked issues into the wrapper shape', async () => {
    const { runner, calls } = stubRunner({
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              state: 'OPEN',
              headRefName: 'feature/foo',
              isDraft: false,
              mergeStateStatus: 'CLEAN',
              closingIssuesReferences: {
                nodes: [
                  {
                    number: 123,
                    repository: { nameWithOwner: 'x/y' },
                  },
                  {
                    number: 789,
                    repository: { nameWithOwner: 'x/z' },
                  },
                ],
              },
            },
          },
        },
      }),
    });
    const wrapper = new GhCliWrapper(runner);
    const detail = await wrapper.getPullRequestGraphqlDetail('x/y', 456);

    expect(detail).toEqual({
      state: 'OPEN',
      headRefName: 'feature/foo',
      isDraft: false,
      mergeStateStatus: 'CLEAN',
      closingIssuesReferences: [
        { number: 123, nameWithOwner: 'x/y' },
        { number: 789, nameWithOwner: 'x/z' },
      ],
    });

    // Runner-spy contract assertions (contracts/graphql-selection-set.md §5).
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    expect(args[0]).toBe('api');
    expect(args[1]).toBe('graphql');
    expect(args).toContain('-F');
    expect(args).toContain('owner=x');
    expect(args).toContain('repo=y');
    expect(args).toContain('number=456');
    const queryArg = args.find((a) => a.startsWith('query='));
    expect(queryArg).toBeDefined();
    expect(queryArg!).toContain('mergeStateStatus');
    expect(queryArg!).toContain('closingIssuesReferences');
    expect(queryArg!).toContain('nameWithOwner');
  });
});

describe('getPullRequestGraphqlDetail — empty closingIssuesReferences', () => {
  it('returns an empty linkage array (FR-006a will refuse downstream)', async () => {
    const { runner } = stubRunner({
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              state: 'OPEN',
              headRefName: 'feature/no-link',
              isDraft: false,
              mergeStateStatus: 'CLEAN',
              closingIssuesReferences: { nodes: [] },
            },
          },
        },
      }),
    });
    const wrapper = new GhCliWrapper(runner);
    const detail = await wrapper.getPullRequestGraphqlDetail('x/y', 456);

    expect(detail.closingIssuesReferences).toEqual([]);
    expect(detail.state).toBe('OPEN');
  });
});

describe('getPullRequestGraphqlDetail — null pullRequest', () => {
  it('throws when the PR does not exist in the target repo', async () => {
    const { runner } = stubRunner({
      stdout: JSON.stringify({
        data: { repository: { pullRequest: null } },
      }),
    });
    const wrapper = new GhCliWrapper(runner);

    await expect(wrapper.getPullRequestGraphqlDetail('x/y', 999)).rejects.toThrow(
      'PR #999 not found in x/y',
    );
  });
});
