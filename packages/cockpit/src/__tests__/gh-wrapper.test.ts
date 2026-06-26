import { describe, expect, it, vi } from 'vitest';
import { GhCliWrapper } from '../gh/wrapper.js';
import type { CommandRunner, CommandResult } from '../gh/command-runner.js';

function stubRunner(result: Partial<CommandResult> = {}): {
  runner: CommandRunner;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner: CommandRunner = vi.fn(async (cmd, args) => {
    calls.push({ cmd, args });
    return {
      stdout: result.stdout ?? '[]',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 0,
    };
  });
  return { runner, calls };
}

describe('GhCliWrapper', () => {
  describe('listIssues', () => {
    it('builds the correct gh search command', async () => {
      const { runner, calls } = stubRunner({
        stdout: JSON.stringify([
          {
            number: 1,
            title: 'A',
            state: 'OPEN',
            labels: [{ name: 'phase:plan' }, { name: 'workflow:speckit-feature' }],
            url: 'https://github.com/o/r/issues/1',
            body: 'body',
            author: { login: 'alice' },
          },
        ]),
      });
      const wrapper = new GhCliWrapper(runner);
      const issues = await wrapper.listIssues('repo:o/r is:issue', { limit: 50 });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.cmd).toBe('gh');
      const args = calls[0]?.args ?? [];
      expect(args.slice(0, 3)).toEqual(['search', 'issues', 'repo:o/r is:issue']);
      expect(args).toContain('--json');
      expect(args).toContain('number,title,state,labels,url,body,author,createdAt');
      expect(args).toContain('--limit');
      expect(args).toContain('50');
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        number: 1,
        title: 'A',
        state: 'OPEN',
        labels: ['phase:plan', 'workflow:speckit-feature'],
        url: 'https://github.com/o/r/issues/1',
        body: 'body',
        author: { login: 'alice' },
      });
    });

    it('defaults limit to 100', async () => {
      const { runner, calls } = stubRunner();
      const wrapper = new GhCliWrapper(runner);
      await wrapper.listIssues('q');
      expect(calls[0]?.args).toContain('100');
    });

    it('passes --repo when provided', async () => {
      const { runner, calls } = stubRunner();
      const wrapper = new GhCliWrapper(runner);
      await wrapper.listIssues('q', { repo: 'o/r' });
      expect(calls[0]?.args).toContain('--repo');
      expect(calls[0]?.args).toContain('o/r');
    });

    it('handles labels as strings or {name}', async () => {
      const { runner } = stubRunner({
        stdout: JSON.stringify([
          {
            number: 7,
            title: 'X',
            state: 'CLOSED',
            labels: ['bug', { name: 'phase:plan' }],
            url: 'u',
            body: null,
          },
        ]),
      });
      const wrapper = new GhCliWrapper(runner);
      const issues = await wrapper.listIssues('q');
      expect(issues[0]?.labels).toEqual(['bug', 'phase:plan']);
      expect(issues[0]?.body).toBe('');
      expect(issues[0]?.state).toBe('CLOSED');
    });

    it('throws on malformed JSON', async () => {
      const { runner } = stubRunner({ stdout: 'not json' });
      const wrapper = new GhCliWrapper(runner);
      await expect(wrapper.listIssues('q')).rejects.toThrow(/malformed JSON/);
    });

    it('throws on non-zero exit', async () => {
      const { runner } = stubRunner({ exitCode: 1, stderr: 'boom' });
      const wrapper = new GhCliWrapper(runner);
      await expect(wrapper.listIssues('q')).rejects.toThrow(/boom/);
    });
  });

  describe('addLabels / removeLabels', () => {
    it('addLabels builds correct gh issue edit invocation', async () => {
      const { runner, calls } = stubRunner({ stdout: '' });
      const wrapper = new GhCliWrapper(runner);
      await wrapper.addLabels('o/r', 42, ['phase:plan', 'agent:dispatched']);
      const args = calls[0]?.args ?? [];
      expect(args.slice(0, 5)).toEqual(['issue', 'edit', '42', '--repo', 'o/r']);
      expect(args).toContain('--add-label');
      expect(args.filter((a) => a === '--add-label')).toHaveLength(2);
      expect(args).toContain('phase:plan');
      expect(args).toContain('agent:dispatched');
    });

    it('addLabels no-op for empty label list', async () => {
      const { runner, calls } = stubRunner();
      const wrapper = new GhCliWrapper(runner);
      await wrapper.addLabels('o/r', 42, []);
      expect(calls).toHaveLength(0);
    });

    it('removeLabels builds correct gh issue edit invocation', async () => {
      const { runner, calls } = stubRunner({ stdout: '' });
      const wrapper = new GhCliWrapper(runner);
      await wrapper.removeLabels('o/r', 42, ['phase:plan']);
      const args = calls[0]?.args ?? [];
      expect(args).toContain('--remove-label');
      expect(args).toContain('phase:plan');
    });

    it('throws on non-zero exit with stderr in message', async () => {
      const { runner } = stubRunner({ exitCode: 2, stderr: 'permission denied' });
      const wrapper = new GhCliWrapper(runner);
      await expect(
        wrapper.addLabels('o/r', 1, ['phase:plan']),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('getPullRequestCheckRuns', () => {
    it('builds correct gh pr checks command and parses output', async () => {
      const { runner, calls } = stubRunner({
        stdout: JSON.stringify([
          { name: 'lint', state: 'SUCCESS', conclusion: 'success', detailsUrl: 'https://x' },
          { name: 'test', state: 'PENDING', conclusion: null },
        ]),
      });
      const wrapper = new GhCliWrapper(runner);
      const checks = await wrapper.getPullRequestCheckRuns('o/r', 99);
      const args = calls[0]?.args ?? [];
      expect(args.slice(0, 5)).toEqual(['pr', 'checks', '99', '--repo', 'o/r']);
      expect(args).toContain('--json');
      expect(checks).toHaveLength(2);
      expect(checks[0]).toMatchObject({
        name: 'lint',
        state: 'SUCCESS',
        conclusion: 'success',
        url: 'https://x',
      });
      expect(checks[1]).toMatchObject({
        name: 'test',
        state: 'PENDING',
      });
    });

    it('throws on malformed JSON', async () => {
      const { runner } = stubRunner({ stdout: '{not valid' });
      const wrapper = new GhCliWrapper(runner);
      await expect(
        wrapper.getPullRequestCheckRuns('o/r', 1),
      ).rejects.toThrow(/malformed JSON/);
    });
  });

  describe('resolveIssueToPR', () => {
    it('returns the first linked PR number from closedByPullRequestsReferences', async () => {
      const { runner, calls } = stubRunner({
        stdout: JSON.stringify({
          closedByPullRequestsReferences: [
            { number: 42, url: 'https://github.com/o/r/pull/42' },
          ],
          timelineItems: [],
        }),
      });
      const wrapper = new GhCliWrapper(runner);
      const n = await wrapper.resolveIssueToPR('o/r', 7);
      expect(n).toBe(42);
      const args = calls[0]?.args ?? [];
      expect(args.slice(0, 5)).toEqual(['issue', 'view', '7', '--repo', 'o/r']);
      expect(args).toContain('--json');
      expect(args).toContain('closedByPullRequestsReferences,timelineItems');
    });

    it('falls back to timelineItems source when references is empty', async () => {
      const { runner } = stubRunner({
        stdout: JSON.stringify({
          closedByPullRequestsReferences: [],
          timelineItems: [
            { source: { __typename: 'PullRequest', number: 99, url: 'https://github.com/o/r/pull/99' } },
          ],
        }),
      });
      const wrapper = new GhCliWrapper(runner);
      expect(await wrapper.resolveIssueToPR('o/r', 7)).toBe(99);
    });

    it('extracts PR number from URL when number absent', async () => {
      const { runner } = stubRunner({
        stdout: JSON.stringify({
          closedByPullRequestsReferences: [{ url: 'https://github.com/o/r/pull/123' }],
        }),
      });
      const wrapper = new GhCliWrapper(runner);
      expect(await wrapper.resolveIssueToPR('o/r', 7)).toBe(123);
    });

    it('returns null when no linked PR exists', async () => {
      const { runner } = stubRunner({
        stdout: JSON.stringify({ closedByPullRequestsReferences: [], timelineItems: [] }),
      });
      const wrapper = new GhCliWrapper(runner);
      expect(await wrapper.resolveIssueToPR('o/r', 7)).toBeNull();
    });

    it('throws on malformed JSON', async () => {
      const { runner } = stubRunner({ stdout: 'not json' });
      const wrapper = new GhCliWrapper(runner);
      await expect(wrapper.resolveIssueToPR('o/r', 7)).rejects.toThrow(/malformed JSON/);
    });
  });

  describe('getPullRequest', () => {
    it('parses state/mergedAt/closedAt/isDraft/labels', async () => {
      const { runner, calls } = stubRunner({
        stdout: JSON.stringify({
          number: 42,
          state: 'MERGED',
          mergedAt: '2026-06-26T10:00:00Z',
          closedAt: '2026-06-26T10:00:00Z',
          url: 'https://github.com/o/r/pull/42',
          isDraft: false,
          labels: [{ name: 'phase:plan' }, 'bug'],
        }),
      });
      const wrapper = new GhCliWrapper(runner);
      const pr = await wrapper.getPullRequest('o/r', 42);
      const args = calls[0]?.args ?? [];
      expect(args.slice(0, 5)).toEqual(['pr', 'view', '42', '--repo', 'o/r']);
      expect(args).toContain('--json');
      expect(args).toContain('number,state,mergedAt,closedAt,url,isDraft,labels');
      expect(pr).toEqual({
        number: 42,
        state: 'MERGED',
        mergedAt: '2026-06-26T10:00:00Z',
        closedAt: '2026-06-26T10:00:00Z',
        url: 'https://github.com/o/r/pull/42',
        isDraft: false,
        labels: ['phase:plan', 'bug'],
      });
    });

    it('coerces CLOSED with mergedAt to MERGED', async () => {
      const { runner } = stubRunner({
        stdout: JSON.stringify({
          number: 1,
          state: 'CLOSED',
          mergedAt: '2026-01-01T00:00:00Z',
          url: 'https://github.com/o/r/pull/1',
          isDraft: false,
          labels: [],
        }),
      });
      const wrapper = new GhCliWrapper(runner);
      const pr = await wrapper.getPullRequest('o/r', 1);
      expect(pr.state).toBe('MERGED');
    });

    it('keeps CLOSED when mergedAt is null', async () => {
      const { runner } = stubRunner({
        stdout: JSON.stringify({
          number: 1,
          state: 'CLOSED',
          mergedAt: null,
          closedAt: '2026-01-01T00:00:00Z',
          url: 'https://github.com/o/r/pull/1',
          isDraft: false,
          labels: [],
        }),
      });
      const wrapper = new GhCliWrapper(runner);
      const pr = await wrapper.getPullRequest('o/r', 1);
      expect(pr.state).toBe('CLOSED');
      expect(pr.mergedAt).toBeUndefined();
      expect(pr.closedAt).toBe('2026-01-01T00:00:00Z');
    });

    it('throws on malformed JSON', async () => {
      const { runner } = stubRunner({ stdout: '{not valid' });
      const wrapper = new GhCliWrapper(runner);
      await expect(wrapper.getPullRequest('o/r', 1)).rejects.toThrow(/malformed JSON/);
    });
  });

  describe('Issue.createdAt round-trips through the zod parser', () => {
    it('preserves createdAt from raw payload', async () => {
      const { runner } = stubRunner({
        stdout: JSON.stringify([
          {
            number: 1,
            title: 'A',
            state: 'OPEN',
            labels: [],
            url: 'https://github.com/o/r/issues/1',
            body: '',
            createdAt: '2026-06-26T08:00:00Z',
          },
        ]),
      });
      const wrapper = new GhCliWrapper(runner);
      const issues = await wrapper.listIssues('q');
      expect(issues[0]?.createdAt).toBe('2026-06-26T08:00:00Z');
    });

    it('defaults createdAt to empty string when absent', async () => {
      const { runner } = stubRunner({
        stdout: JSON.stringify([
          { number: 1, title: 'A', state: 'OPEN', labels: [], url: 'u', body: '' },
        ]),
      });
      const wrapper = new GhCliWrapper(runner);
      const issues = await wrapper.listIssues('q');
      expect(issues[0]?.createdAt).toBe('');
    });
  });
});
