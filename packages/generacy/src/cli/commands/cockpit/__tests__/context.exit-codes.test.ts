import { describe, it, expect, vi } from 'vitest';
import type { GhWrapper } from '@generacy-ai/cockpit';
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
    resolveIssueToPRRef: vi.fn(async () => ({ kind: 'unresolved' })),
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

describe('cockpit context — SC-005 exit codes', () => {
  it('exit 0: successful clarification bundle', async () => {
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({ labels: ['waiting-for:clarification'] })),
      fetchIssueTimeline: vi.fn(async () => []),
      fetchIssueComments: vi.fn(async () => []),
    });
    const bundle = await runContext('owner/repo#7', {
      gh,
      cwd: '/tmp/nowhere-807-test',
      getBranch: async () => '',
      stdout: () => {},
    });
    expect(bundle.gate).toBe('waiting-for:clarification');
  });

  it('exit 1: gh runner rejects', async () => {
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => {
        throw new Error('gh boom');
      }),
    });
    await expect(
      runContext('owner/repo#7', { gh, stdout: () => {} }),
    ).rejects.toMatchObject({
      code: 1,
      message: expect.stringMatching(/^Error: cockpit context: gh /),
    });
  });

  it('exit 2: bare-number ref with no git origin', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: 'no remote', exitCode: 128 }));
    await expect(
      runContext('123', { runner, stdout: () => {} }),
    ).rejects.toMatchObject({
      code: 2,
      message: expect.stringMatching(/parse issue/),
    });
  });

  it('exit 3a: no waiting-for:* label', async () => {
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({ labels: ['phase:plan'] })),
    });
    await expect(
      runContext('owner/repo#7', { gh, stdout: () => {} }),
    ).rejects.toMatchObject({
      code: 3,
      message: expect.stringMatching(/gate refusal: no waiting-for/),
    });
  });

  it('exit 3b: completed:validate label routes to `cockpit merge`', async () => {
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({ labels: ['completed:validate'] })),
    });
    await expect(
      runContext('owner/repo#7', { gh, stdout: () => {} }),
    ).rejects.toMatchObject({
      code: 3,
      message: expect.stringContaining('use `cockpit merge`'),
    });
  });

  it('exit 3c: PR-scoped gate with no linked PR', async () => {
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({ labels: ['waiting-for:implementation-review'] })),
      resolveIssueToPRRef: vi.fn(async () => ({ kind: 'unresolved' })),
    });
    await expect(
      runContext('owner/repo#7', { gh, stdout: () => {} }),
    ).rejects.toMatchObject({
      code: 3,
      message: expect.stringContaining('no linked PR resolved'),
    });
  });

  it('exit 3d: unsupported waiting-for gate string', async () => {
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({ labels: ['waiting-for:something-new'] })),
    });
    await expect(
      runContext('owner/repo#7', { gh, stdout: () => {} }),
    ).rejects.toMatchObject({
      code: 3,
      message: expect.stringContaining('unsupported gate'),
    });
  });

  it('every branch throws a typed CockpitExit', async () => {
    const gh = stubGh();
    try {
      await runContext('owner/repo#7', { gh, stdout: () => {} });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CockpitExit);
    }
  });
});
