import { describe, it, expect, vi } from 'vitest';
import type { CommandRunner, GhWrapper } from '@generacy-ai/cockpit';
import { CockpitExit } from '../exit.js';
import { runContext } from '../context.js';

function stubGh(overrides: Partial<GhWrapper> = {}): GhWrapper {
  const base: Partial<GhWrapper> = {
    fetchIssueLabels: vi.fn(async () => ({ labels: [] })),
    fetchIssueTimeline: vi.fn(async () => []),
    fetchIssueComments: vi.fn(async () => []),
    findOpenPrForBranch: vi.fn(async () => null),
    prDiffNames: vi.fn(async () => []),
    prDiffPatch: vi.fn(async () => ''),
    resolveIssueToPRRef: vi.fn(async () => null),
    getPullRequestDetail: vi.fn(),
    getPullRequestCheckRuns: vi.fn(async () => []),
    listIssues: vi.fn(),
    getIssue: vi.fn(),
    addLabels: vi.fn(),
    removeLabels: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    resolveIssueToPR: vi.fn(),
    getPullRequest: vi.fn(),
    mergePullRequest: vi.fn(),
    getRequiredCheckNames: vi.fn(),
    fetchIssueState: vi.fn(),
    postIssueComment: vi.fn(),
    addAssignees: vi.fn(),
    getCurrentUser: vi.fn(),
  };
  return { ...base, ...overrides } as GhWrapper;
}

describe('cockpit context — bare-number ref resolution (#850)', () => {
  it('bare-number happy path: infers repo from git origin and reaches label lookup', async () => {
    const fetchLabels = vi.fn(async () => ({ labels: ['waiting-for:clarification'] }));
    const gh = stubGh({
      fetchIssueLabels: fetchLabels,
      fetchIssueTimeline: vi.fn(async () => []),
      fetchIssueComments: vi.fn(async () => []),
    });
    const runner: CommandRunner = vi.fn(async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'remote') {
        return { stdout: 'https://github.com/owner/repo.git\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const bundle = await runContext('2', {
      gh,
      runner,
      cwd: '/tmp/nowhere-850-test',
      getBranch: async () => '',
      stdout: () => {},
    });
    expect(bundle.gate).toBe('waiting-for:clarification');
    expect(fetchLabels).toHaveBeenCalledWith('owner/repo', 2);
  });

  it('bare-number failure: unresolvable origin → CockpitExit(2) with FR-002 copy', async () => {
    const gh = stubGh();
    const runner: CommandRunner = vi.fn(async () => ({
      stdout: '',
      stderr: 'fatal: no such remote',
      exitCode: 128,
    }));
    let caught: unknown = null;
    try {
      await runContext('2', { gh, runner, stdout: () => {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CockpitExit);
    const exit = caught as CockpitExit;
    expect(exit.code).toBe(2);
    expect(exit.message).toMatch(
      /^Error: cockpit context: parse issue: bare issue number "2" is not accepted here\./,
    );
    expect(exit.message).toMatch(
      /Accepted: <owner>\/<repo>#2, a full issue URL, or a bare number inside a checkout/,
    );
  });

  it('regression: owner/repo#N still routes with no runner call for origin', async () => {
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({ labels: ['waiting-for:clarification'] })),
      fetchIssueTimeline: vi.fn(async () => []),
      fetchIssueComments: vi.fn(async () => []),
    });
    const runner: CommandRunner = vi.fn(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));
    await runContext('owner/repo#7', {
      gh,
      runner,
      cwd: '/tmp/nowhere-850-test',
      getBranch: async () => '',
      stdout: () => {},
    });
    for (const call of (runner as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).not.toEqual(['remote', 'get-url', 'origin']);
    }
  });
});
