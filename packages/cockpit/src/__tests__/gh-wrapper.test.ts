import { describe, expect, it, vi } from 'vitest';
import {
  GhCliWrapper,
  DIFF_BYTE_CAP,
  DIFF_TRUNCATION_MARKER,
} from '../gh/wrapper.js';
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

function queuedRunner(
  queue: Array<Partial<CommandResult>>,
): { runner: CommandRunner; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let i = 0;
  const runner: CommandRunner = vi.fn(async (cmd, args) => {
    calls.push({ cmd, args });
    const next = queue[i++] ?? {};
    return {
      stdout: next.stdout ?? '',
      stderr: next.stderr ?? '',
      exitCode: next.exitCode ?? 0,
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
      expect(args.slice(0, 4)).toEqual(['search', 'issues', 'repo:o/r', 'is:issue']);
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

    it('splits multi-qualifier queries into separate args (regression: no arg holds spaces)', async () => {
      const { runner, calls } = stubRunner();
      const wrapper = new GhCliWrapper(runner);
      await wrapper.listIssues('repo:o/r is:issue label:epic-child #85');
      const args = calls[0]?.args ?? [];
      expect(args.slice(0, 6)).toEqual([
        'search',
        'issues',
        'repo:o/r',
        'is:issue',
        'label:epic-child',
        '#85',
      ]);
      // Previously the whole query was passed as one arg, so gh folded the
      // trailing qualifiers into repo:"o/r is:issue ..." and rejected the query.
      for (const arg of args) expect(arg).not.toMatch(/\s/);
    });

    it('keeps quoted phrases as a single arg', async () => {
      const { runner, calls } = stubRunner();
      const wrapper = new GhCliWrapper(runner);
      await wrapper.listIssues('repo:o/r "exact phrase"');
      expect(calls[0]?.args.slice(0, 4)).toEqual([
        'search',
        'issues',
        'repo:o/r',
        '"exact phrase"',
      ]);
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
          { name: 'lint', state: 'pass', bucket: 'pass', link: 'https://x' },
          { name: 'test', state: 'pending', bucket: 'pending' },
        ]),
      });
      const wrapper = new GhCliWrapper(runner);
      const checks = await wrapper.getPullRequestCheckRuns('o/r', 99);
      const args = calls[0]?.args ?? [];
      expect(args.slice(0, 5)).toEqual(['pr', 'checks', '99', '--repo', 'o/r']);
      expect(args).toContain('--json');
      expect(args).toContain('name,state,bucket,link');
      expect(checks).toHaveLength(2);
      expect(checks[0]).toMatchObject({
        name: 'lint',
        state: 'SUCCESS',
        url: 'https://x',
      });
      expect(checks[0]).not.toHaveProperty('conclusion');
      expect(checks[1]).toMatchObject({
        name: 'test',
        state: 'PENDING',
      });
    });

    it('maps bucket=cancel to CANCELLED state', async () => {
      const { runner } = stubRunner({
        stdout: JSON.stringify([
          { name: 'cancelled-check', bucket: 'cancel', link: 'https://y' },
        ]),
      });
      const wrapper = new GhCliWrapper(runner);
      const checks = await wrapper.getPullRequestCheckRuns('o/r', 1);
      expect(checks[0]).toMatchObject({
        name: 'cancelled-check',
        state: 'CANCELLED',
        url: 'https://y',
      });
    });

    it('throws on malformed JSON', async () => {
      const { runner } = stubRunner({ stdout: '{not valid' });
      const wrapper = new GhCliWrapper(runner);
      await expect(
        wrapper.getPullRequestCheckRuns('o/r', 1),
      ).rejects.toThrow(/malformed JSON/);
    });

    it('emits warn log and rethrows on non-zero exit', async () => {
      const logger = { warn: vi.fn() };
      const runner: CommandRunner = async () => ({
        stdout: '',
        stderr: 'Unknown JSON field: "foo"',
        exitCode: 1,
      });
      const wrapper = new GhCliWrapper(runner, logger);
      await expect(
        wrapper.getPullRequestCheckRuns('o/r', 99),
      ).rejects.toThrow(/gh pr checks failed/);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        { repo: 'o/r', prNumber: 99, ghStderr: 'Unknown JSON field: "foo"' },
        'gh pr checks failed',
      );
    });
  });

  describe('resolveIssueToPR', () => {
    it('returns the first linked PR number from closedByPullRequestsReferences', async () => {
      const { runner, calls } = stubRunner({
        stdout: JSON.stringify({
          closedByPullRequestsReferences: [
            { number: 42, url: 'https://github.com/o/r/pull/42' },
          ],
        }),
      });
      const wrapper = new GhCliWrapper(runner);
      const n = await wrapper.resolveIssueToPR('o/r', 7);
      expect(n).toBe(42);
      const args = calls[0]?.args ?? [];
      expect(args.slice(0, 5)).toEqual(['issue', 'view', '7', '--repo', 'o/r']);
      expect(args).toContain('--json');
      expect(args).toContain('closedByPullRequestsReferences');
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
        stdout: JSON.stringify({ closedByPullRequestsReferences: [] }),
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

  describe('resolveIssueToPRRef', () => {
    it('returns the first PR from gh pr list search', async () => {
      const { runner, calls } = queuedRunner([
        {
          stdout: JSON.stringify([
            {
              number: 42,
              url: 'https://github.com/o/r/pull/42',
              state: 'OPEN',
              isDraft: false,
              headRefName: 'feature/x',
            },
          ]),
        },
      ]);
      const wrapper = new GhCliWrapper(runner);
      const ref = await wrapper.resolveIssueToPRRef('o/r', 7);
      expect(ref).toEqual({
        number: 42,
        url: 'https://github.com/o/r/pull/42',
        state: 'OPEN',
        draft: false,
        headRefName: 'feature/x',
      });
      const args = calls[0]?.args ?? [];
      expect(args.slice(0, 4)).toEqual(['pr', 'list', '--repo', 'o/r']);
      expect(args).toContain('--search');
      expect(args).toContain('linked:7');
      expect(args).toContain('--state');
      expect(args).toContain('open');
      expect(args).toContain('--limit');
      expect(args).toContain('1');
    });

    it('falls back to issue view closedByPullRequestsReferences', async () => {
      const { runner, calls } = queuedRunner([
        { stdout: '[]' },
        {
          stdout: JSON.stringify({
            closedByPullRequestsReferences: [
              {
                number: 99,
                url: 'https://github.com/o/r/pull/99',
                state: 'MERGED',
                isDraft: false,
                headRefName: 'feature/y',
              },
            ],
          }),
        },
      ]);
      const wrapper = new GhCliWrapper(runner);
      const ref = await wrapper.resolveIssueToPRRef('o/r', 11);
      expect(ref).toEqual({
        number: 99,
        url: 'https://github.com/o/r/pull/99',
        state: 'MERGED',
        draft: false,
        headRefName: 'feature/y',
      });
      expect(calls).toHaveLength(2);
      const args = calls[1]?.args ?? [];
      expect(args.slice(0, 5)).toEqual(['issue', 'view', '11', '--repo', 'o/r']);
    });

    it('returns null when neither path yields a PR', async () => {
      const { runner } = queuedRunner([
        { stdout: '[]' },
        { stdout: JSON.stringify({ closedByPullRequestsReferences: [] }) },
      ]);
      const wrapper = new GhCliWrapper(runner);
      const ref = await wrapper.resolveIssueToPRRef('o/r', 1);
      expect(ref).toBeNull();
    });

    it('normalizes lowercase state to uppercase', async () => {
      const { runner } = queuedRunner([
        {
          stdout: JSON.stringify([
            {
              number: 1,
              url: 'u',
              state: 'open',
              headRefName: 'h',
            },
          ]),
        },
      ]);
      const wrapper = new GhCliWrapper(runner);
      const ref = await wrapper.resolveIssueToPRRef('o/r', 1);
      expect(ref?.state).toBe('OPEN');
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

  describe('getPullRequestDetail', () => {
    it('returns full metadata + sub-cap diff', async () => {
      const diffText = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n';
      const { runner, calls } = queuedRunner([
        {
          stdout: JSON.stringify({
            number: 5,
            title: 'My PR',
            url: 'https://github.com/o/r/pull/5',
            baseRefName: 'develop',
            headRefName: 'feature/z',
            body: 'PR body text',
            author: { login: 'alice' },
            state: 'OPEN',
            isDraft: false,
            labels: [{ name: 'completed:validate' }, 'phase:plan'],
          }),
        },
        { stdout: diffText },
      ]);
      const wrapper = new GhCliWrapper(runner);
      const pr = await wrapper.getPullRequestDetail('o/r', 5);
      expect(pr).toEqual({
        number: 5,
        title: 'My PR',
        url: 'https://github.com/o/r/pull/5',
        base: 'develop',
        head: 'feature/z',
        body: 'PR body text',
        author: { login: 'alice' },
        state: 'OPEN',
        draft: false,
        labels: ['completed:validate', 'phase:plan'],
        diff: diffText,
        diffTruncated: false,
      });
      const viewArgs = calls[0]?.args ?? [];
      expect(viewArgs.slice(0, 5)).toEqual(['pr', 'view', '5', '--repo', 'o/r']);
      expect(viewArgs).toContain('--json');
      const diffArgs = calls[1]?.args ?? [];
      expect(diffArgs.slice(0, 5)).toEqual(['pr', 'diff', '5', '--repo', 'o/r']);
    });

    it('truncates over-cap diff with marker', async () => {
      const big = 'a'.repeat(DIFF_BYTE_CAP + 1024);
      const { runner } = queuedRunner([
        {
          stdout: JSON.stringify({
            number: 1,
            title: 't',
            url: 'u',
            baseRefName: 'develop',
            headRefName: 'h',
            body: null,
            author: null,
            state: 'OPEN',
            isDraft: false,
            labels: [],
          }),
        },
        { stdout: big },
      ]);
      const wrapper = new GhCliWrapper(runner);
      const pr = await wrapper.getPullRequestDetail('o/r', 1);
      expect(pr.diffTruncated).toBe(true);
      expect(pr.diff.endsWith(DIFF_TRUNCATION_MARKER)).toBe(true);
      const diffBuf = Buffer.from(pr.diff, 'utf-8');
      expect(diffBuf.byteLength).toBeLessThanOrEqual(
        DIFF_BYTE_CAP + Buffer.byteLength(DIFF_TRUNCATION_MARKER, 'utf-8'),
      );
      expect(pr.author).toBeNull();
      expect(pr.body).toBe('');
    });

    it('normalizes MERGED state from gh pr view', async () => {
      const { runner } = queuedRunner([
        {
          stdout: JSON.stringify({
            number: 1,
            title: 't',
            url: 'u',
            baseRefName: 'develop',
            headRefName: 'h',
            body: '',
            author: { login: 'a' },
            state: 'merged',
            isDraft: false,
            labels: [],
          }),
        },
        { stdout: '' },
      ]);
      const wrapper = new GhCliWrapper(runner);
      const pr = await wrapper.getPullRequestDetail('o/r', 1);
      expect(pr.state).toBe('MERGED');
    });
  });

  describe('mergePullRequest', () => {
    it('squash-merges and returns commit sha from follow-up view', async () => {
      const { runner, calls } = queuedRunner([
        { stdout: 'merged' },
        {
          stdout: JSON.stringify({
            mergeCommit: { oid: 'abc123def456' },
          }),
        },
      ]);
      const wrapper = new GhCliWrapper(runner);
      const result = await wrapper.mergePullRequest('o/r', 5, { squash: true });
      expect(result).toEqual({ merged: true, commitSha: 'abc123def456' });
      const mergeArgs = calls[0]?.args ?? [];
      expect(mergeArgs.slice(0, 5)).toEqual(['pr', 'merge', '5', '--repo', 'o/r']);
      expect(mergeArgs).toContain('--squash');
      expect(mergeArgs).toContain('--delete-branch=false');
    });

    it('throws on non-zero exit from gh pr merge', async () => {
      const { runner } = queuedRunner([
        { exitCode: 1, stderr: 'merge conflict' },
      ]);
      const wrapper = new GhCliWrapper(runner);
      await expect(
        wrapper.mergePullRequest('o/r', 5, { squash: true }),
      ).rejects.toThrow(/merge conflict/);
    });

    it('returns merged:true without sha when follow-up view fails', async () => {
      const { runner } = queuedRunner([
        { stdout: 'merged' },
        { exitCode: 1, stderr: 'boom' },
      ]);
      const wrapper = new GhCliWrapper(runner);
      const result = await wrapper.mergePullRequest('o/r', 5, { squash: true });
      expect(result).toEqual({ merged: true });
    });
  });

  describe('getRequiredCheckNames', () => {
    it('returns branch-protection names on 200 success', async () => {
      const { runner, calls } = queuedRunner([
        {
          stdout: JSON.stringify({
            required_status_checks: {
              contexts: ['ci/lint', 'ci/test'],
            },
          }),
        },
      ]);
      const wrapper = new GhCliWrapper(runner);
      const result = await wrapper.getRequiredCheckNames('o/r', 'develop');
      expect(result).toEqual({
        source: 'branch-protection',
        names: ['ci/lint', 'ci/test'],
      });
      const args = calls[0]?.args ?? [];
      expect(args.slice(0, 2)).toEqual(['api', 'repos/o/r/branches/develop/protection']);
    });

    it('falls back on 403', async () => {
      const { runner } = queuedRunner([
        { exitCode: 1, stderr: 'HTTP 403: Resource not accessible' },
      ]);
      const wrapper = new GhCliWrapper(runner);
      const result = await wrapper.getRequiredCheckNames('o/r', 'develop');
      expect(result).toEqual({ source: 'fallback-pr-checks', names: null });
    });

    it('falls back on 404 (no protection configured)', async () => {
      const { runner } = queuedRunner([
        { exitCode: 1, stderr: 'HTTP 404: Branch not protected' },
      ]);
      const wrapper = new GhCliWrapper(runner);
      const result = await wrapper.getRequiredCheckNames('o/r', 'develop');
      expect(result).toEqual({ source: 'fallback-pr-checks', names: null });
    });

    it('throws on non-403/404 errors', async () => {
      const { runner } = queuedRunner([
        { exitCode: 1, stderr: 'HTTP 500: Internal Server Error' },
      ]);
      const wrapper = new GhCliWrapper(runner);
      await expect(
        wrapper.getRequiredCheckNames('o/r', 'develop'),
      ).rejects.toThrow(/HTTP 500/);
    });

    it('throws when repo is malformed', async () => {
      const { runner } = stubRunner();
      const wrapper = new GhCliWrapper(runner);
      await expect(
        wrapper.getRequiredCheckNames('badrepo', 'develop'),
      ).rejects.toThrow(/owner\/name/);
    });

    it('returns empty contexts list when none configured', async () => {
      const { runner } = queuedRunner([
        {
          stdout: JSON.stringify({
            required_status_checks: { contexts: [] },
          }),
        },
      ]);
      const wrapper = new GhCliWrapper(runner);
      const result = await wrapper.getRequiredCheckNames('o/r', 'develop');
      expect(result).toEqual({ source: 'branch-protection', names: [] });
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
