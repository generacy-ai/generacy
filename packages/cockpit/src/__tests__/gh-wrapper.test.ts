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
        stateReason: null,
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

    it('#873: --json field list includes stateReason (getIssue)', async () => {
      const { runner, calls } = stubRunner({
        stdout: JSON.stringify({
          number: 5,
          title: 'A',
          state: 'CLOSED',
          stateReason: 'COMPLETED',
          labels: [],
          url: 'u',
          body: '',
        }),
      });
      const wrapper = new GhCliWrapper(runner);
      await wrapper.getIssue('o/r', 5);
      const args = calls[0]?.args ?? [];
      expect(args).toContain('--json');
      expect(args).toContain(
        'number,title,state,stateReason,labels,url,body,author,createdAt',
      );
    });

    it("#873: stateReason 'COMPLETED' propagates verbatim through listIssues", async () => {
      const { runner } = stubRunner({
        stdout: JSON.stringify([
          {
            number: 1,
            title: 'X',
            state: 'CLOSED',
            stateReason: 'COMPLETED',
            labels: [],
            url: 'u',
            body: '',
          },
        ]),
      });
      const wrapper = new GhCliWrapper(runner);
      const issues = await wrapper.listIssues('q');
      expect(issues[0]?.stateReason).toBe('COMPLETED');
    });

    it("#873: stateReason 'NOT_PLANNED' propagates verbatim through listIssues", async () => {
      const { runner } = stubRunner({
        stdout: JSON.stringify([
          {
            number: 1,
            title: 'X',
            state: 'CLOSED',
            stateReason: 'NOT_PLANNED',
            labels: [],
            url: 'u',
            body: '',
          },
        ]),
      });
      const wrapper = new GhCliWrapper(runner);
      const issues = await wrapper.listIssues('q');
      expect(issues[0]?.stateReason).toBe('NOT_PLANNED');
    });

    it('#873: missing stateReason coerces to null', async () => {
      const { runner } = stubRunner({
        stdout: JSON.stringify([
          {
            number: 1,
            title: 'X',
            state: 'OPEN',
            labels: [],
            url: 'u',
            body: '',
          },
        ]),
      });
      const wrapper = new GhCliWrapper(runner);
      const issues = await wrapper.listIssues('q');
      expect(issues[0]?.stateReason).toBeNull();
    });

    it('#873: null stateReason stays null', async () => {
      const { runner } = stubRunner({
        stdout: JSON.stringify([
          {
            number: 1,
            title: 'X',
            state: 'OPEN',
            stateReason: null,
            labels: [],
            url: 'u',
            body: '',
          },
        ]),
      });
      const wrapper = new GhCliWrapper(runner);
      const issues = await wrapper.listIssues('q');
      expect(issues[0]?.stateReason).toBeNull();
    });

    it('#873: unknown stateReason string coerces to null (degrades gracefully)', async () => {
      const { runner } = stubRunner({
        stdout: JSON.stringify([
          {
            number: 1,
            title: 'X',
            state: 'CLOSED',
            stateReason: 'SOME_FUTURE_REASON',
            labels: [],
            url: 'u',
            body: '',
          },
        ]),
      });
      const wrapper = new GhCliWrapper(runner);
      const issues = await wrapper.listIssues('q');
      expect(issues[0]?.stateReason).toBeNull();
    });

    it('#873: getIssue propagates stateReason verbatim', async () => {
      const { runner } = stubRunner({
        stdout: JSON.stringify({
          number: 7,
          title: 'Y',
          state: 'CLOSED',
          stateReason: 'NOT_PLANNED',
          labels: [],
          url: 'u',
          body: '',
        }),
      });
      const wrapper = new GhCliWrapper(runner);
      const issue = await wrapper.getIssue('o/r', 7);
      expect(issue.stateReason).toBe('NOT_PLANNED');
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

    it('resolves [] and does not warn when stderr says "no checks reported" (#857)', async () => {
      const logger = { warn: vi.fn() };
      const runner: CommandRunner = async () => ({
        stdout: '',
        stderr: "no checks reported on the '002-phase-1-foundation-part' branch",
        exitCode: 1,
      });
      const wrapper = new GhCliWrapper(runner, logger);
      const result = await wrapper.getPullRequestCheckRuns('o/r', 16);
      expect(result).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('detects "no checks reported" case-insensitively (#857)', async () => {
      const logger = { warn: vi.fn() };
      const runner: CommandRunner = async () => ({
        stdout: '',
        stderr: 'No Checks Reported',
        exitCode: 1,
      });
      const wrapper = new GhCliWrapper(runner, logger);
      const result = await wrapper.getPullRequestCheckRuns('o/r', 1);
      expect(result).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('still throws + warns when stderr mentions checks but not the fixed literal (#857)', async () => {
      const logger = { warn: vi.fn() };
      const runner: CommandRunner = async () => ({
        stdout: '',
        stderr: 'Some other error mentioning checks',
        exitCode: 1,
      });
      const wrapper = new GhCliWrapper(runner, logger);
      await expect(
        wrapper.getPullRequestCheckRuns('o/r', 1),
      ).rejects.toThrow(/gh pr checks failed/);
      expect(logger.warn).toHaveBeenCalledTimes(1);
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

  describe('resolveIssueToPRRef (#904 — three-tier deterministic resolver)', () => {
    // Helper: build a fake PR JSON blob returned by gh
    const rawPr = (overrides: {
      number: number;
      url?: string;
      state?: 'OPEN' | 'CLOSED' | 'MERGED';
      isDraft?: boolean;
      headRefName?: string;
    }): Record<string, unknown> => ({
      number: overrides.number,
      url: overrides.url ?? `https://github.com/o/r/pull/${overrides.number}`,
      state: overrides.state ?? 'OPEN',
      isDraft: overrides.isDraft ?? false,
      headRefName: overrides.headRefName ?? `${overrides.number}-branch`,
    });

    const tier1Response = (
      prs: ReturnType<typeof rawPr>[],
    ): { stdout: string } => ({
      stdout: JSON.stringify({ closedByPullRequestsReferences: prs }),
    });

    const tier2Or3Response = (
      prs: ReturnType<typeof rawPr>[],
    ): { stdout: string } => ({
      stdout: JSON.stringify(prs),
    });

    const emptyTier1 = tier1Response([]);
    const emptyTier2Or3 = tier2Or3Response([]);

    describe('Tier 1: closing-refs (gh issue view --json closedByPullRequestsReferences)', () => {
      it('exactly-one non-draft OPEN candidate → resolved', async () => {
        const { runner, calls } = queuedRunner([
          tier1Response([rawPr({ number: 23 })]),
        ]);
        const wrapper = new GhCliWrapper(runner);
        const result = await wrapper.resolveIssueToPRRef('o/r', 9);
        expect(result).toEqual({
          kind: 'resolved',
          ref: {
            number: 23,
            url: 'https://github.com/o/r/pull/23',
            state: 'OPEN',
            draft: false,
            headRefName: '23-branch',
          },
          linkMethod: 'closing-refs',
        });
        // Tier 2 and Tier 3 must NOT be called.
        expect(calls).toHaveLength(1);
        const args = calls[0]?.args ?? [];
        expect(args.slice(0, 5)).toEqual(['issue', 'view', '9', '--repo', 'o/r']);
        expect(args).toContain('closedByPullRequestsReferences');
      });

      it('≥2 non-drafts at Tier 1 → ambiguous', async () => {
        const { runner, calls } = queuedRunner([
          tier1Response([rawPr({ number: 23 }), rawPr({ number: 24 })]),
        ]);
        const wrapper = new GhCliWrapper(runner);
        const result = await wrapper.resolveIssueToPRRef('o/r', 9);
        expect(result.kind).toBe('ambiguous');
        if (result.kind === 'ambiguous') {
          expect(result.candidates.map((c) => c.number)).toEqual([23, 24]);
          expect(result.linkMethod).toBe('closing-refs');
        }
        expect(calls).toHaveLength(1);
      });

      it('zero non-drafts + ≥1 drafts at Tier 1 → pr-is-draft', async () => {
        const { runner, calls } = queuedRunner([
          tier1Response([rawPr({ number: 22, isDraft: true })]),
        ]);
        const wrapper = new GhCliWrapper(runner);
        const result = await wrapper.resolveIssueToPRRef('o/r', 9);
        expect(result.kind).toBe('pr-is-draft');
        if (result.kind === 'pr-is-draft') {
          expect(result.candidates.map((c) => c.number)).toEqual([22]);
          expect(result.linkMethod).toBe('closing-refs');
        }
        expect(calls).toHaveLength(1);
      });

      it('zero PRs at Tier 1 → falls through to Tier 2', async () => {
        const { runner, calls } = queuedRunner([
          emptyTier1,
          tier2Or3Response([rawPr({ number: 42 })]),
        ]);
        const wrapper = new GhCliWrapper(runner);
        const result = await wrapper.resolveIssueToPRRef('o/r', 9);
        expect(result.kind).toBe('resolved');
        expect(calls).toHaveLength(2);
        const t2Args = calls[1]?.args ?? [];
        expect(t2Args.slice(0, 4)).toEqual(['pr', 'list', '--repo', 'o/r']);
        expect(t2Args).toContain('head:9-');
      });

      it('Tier 1 CLOSED PRs are filtered out before evaluateTier', async () => {
        // A CLOSED candidate + an OPEN candidate — the CLOSED one is filtered
        // out; the single OPEN remainder yields `resolved`, not `ambiguous`.
        const { runner } = queuedRunner([
          tier1Response([
            rawPr({ number: 99, state: 'CLOSED' }),
            rawPr({ number: 42 }),
          ]),
        ]);
        const wrapper = new GhCliWrapper(runner);
        const result = await wrapper.resolveIssueToPRRef('o/r', 9);
        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') {
          expect(result.ref.number).toBe(42);
        }
      });
    });

    describe('Tier 2: branch-name (gh pr list --search head:<n>-)', () => {
      it('exactly-one non-draft at Tier 2 → resolved', async () => {
        const { runner, calls } = queuedRunner([
          emptyTier1,
          tier2Or3Response([rawPr({ number: 42 })]),
        ]);
        const wrapper = new GhCliWrapper(runner);
        const result = await wrapper.resolveIssueToPRRef('o/r', 9);
        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') {
          expect(result.linkMethod).toBe('branch-name');
        }
        expect(calls).toHaveLength(2);
      });

      it('≥2 non-drafts at Tier 2 → ambiguous with linkMethod=branch-name', async () => {
        const { runner, calls } = queuedRunner([
          emptyTier1,
          tier2Or3Response([rawPr({ number: 42 }), rawPr({ number: 47 })]),
        ]);
        const wrapper = new GhCliWrapper(runner);
        const result = await wrapper.resolveIssueToPRRef('o/r', 9);
        expect(result.kind).toBe('ambiguous');
        if (result.kind === 'ambiguous') {
          expect(result.linkMethod).toBe('branch-name');
        }
        expect(calls).toHaveLength(2);
      });

      it('drafts-only at Tier 2 → pr-is-draft with linkMethod=branch-name', async () => {
        const { runner } = queuedRunner([
          emptyTier1,
          tier2Or3Response([rawPr({ number: 22, isDraft: true })]),
        ]);
        const wrapper = new GhCliWrapper(runner);
        const result = await wrapper.resolveIssueToPRRef('o/r', 9);
        expect(result.kind).toBe('pr-is-draft');
        if (result.kind === 'pr-is-draft') {
          expect(result.linkMethod).toBe('branch-name');
        }
      });

      it('zero PRs at Tier 2 → falls through to Tier 3', async () => {
        const { runner, calls } = queuedRunner([
          emptyTier1,
          emptyTier2Or3,
          tier2Or3Response([rawPr({ number: 100 })]),
        ]);
        const wrapper = new GhCliWrapper(runner);
        const result = await wrapper.resolveIssueToPRRef('o/r', 9);
        expect(result.kind).toBe('resolved');
        expect(calls).toHaveLength(3);
        const t3Args = calls[2]?.args ?? [];
        expect(t3Args.slice(0, 4)).toEqual(['pr', 'list', '--repo', 'o/r']);
        expect(t3Args).toContain('9 in:body');
      });
    });

    describe('Tier 3: pr-body (gh pr list --search <n> in:body)', () => {
      it('exactly-one non-draft at Tier 3 → resolved with linkMethod=pr-body', async () => {
        const { runner } = queuedRunner([
          emptyTier1,
          emptyTier2Or3,
          tier2Or3Response([rawPr({ number: 100 })]),
        ]);
        const wrapper = new GhCliWrapper(runner);
        const result = await wrapper.resolveIssueToPRRef('o/r', 9);
        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') {
          expect(result.linkMethod).toBe('pr-body');
        }
      });

      it('≥2 non-drafts at Tier 3 → ambiguous with linkMethod=pr-body', async () => {
        const { runner } = queuedRunner([
          emptyTier1,
          emptyTier2Or3,
          tier2Or3Response([rawPr({ number: 100 }), rawPr({ number: 101 })]),
        ]);
        const wrapper = new GhCliWrapper(runner);
        const result = await wrapper.resolveIssueToPRRef('o/r', 9);
        expect(result.kind).toBe('ambiguous');
        if (result.kind === 'ambiguous') {
          expect(result.linkMethod).toBe('pr-body');
        }
      });

      it('drafts-only at Tier 3 → pr-is-draft with linkMethod=pr-body', async () => {
        const { runner } = queuedRunner([
          emptyTier1,
          emptyTier2Or3,
          tier2Or3Response([rawPr({ number: 22, isDraft: true })]),
        ]);
        const wrapper = new GhCliWrapper(runner);
        const result = await wrapper.resolveIssueToPRRef('o/r', 9);
        expect(result.kind).toBe('pr-is-draft');
        if (result.kind === 'pr-is-draft') {
          expect(result.linkMethod).toBe('pr-body');
        }
      });

      it('zero PRs at all three tiers → unresolved', async () => {
        const { runner, calls } = queuedRunner([
          emptyTier1,
          emptyTier2Or3,
          emptyTier2Or3,
        ]);
        const wrapper = new GhCliWrapper(runner);
        const result = await wrapper.resolveIssueToPRRef('o/r', 9);
        expect(result).toEqual({ kind: 'unresolved' });
        expect(calls).toHaveLength(3);
      });
    });

    describe('SC-001 sniplink fixture (Tier 1 short-circuits)', () => {
      it('Tier 1 returns [#23] → resolved via closing-refs; Tier 2/3 NEVER invoked', async () => {
        // The core SC-001 fixture: Tier 1 has a single non-draft candidate #23,
        // Tier 3 would return [#23, #22-draft, #24-draft, #25-draft] but must not
        // be queried because Tier 1 short-circuits.
        const { runner, calls } = queuedRunner([
          tier1Response([rawPr({ number: 23 })]),
          // These would be for Tier 2 / Tier 3 but must not be consumed.
          tier2Or3Response([
            rawPr({ number: 23 }),
            rawPr({ number: 22, isDraft: true }),
            rawPr({ number: 24, isDraft: true }),
            rawPr({ number: 25, isDraft: true }),
          ]),
          tier2Or3Response([
            rawPr({ number: 23 }),
            rawPr({ number: 22, isDraft: true }),
            rawPr({ number: 24, isDraft: true }),
            rawPr({ number: 25, isDraft: true }),
          ]),
        ]);
        const wrapper = new GhCliWrapper(runner);
        const result = await wrapper.resolveIssueToPRRef('o/r', 9);
        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') {
          expect(result.ref.number).toBe(23);
          expect(result.linkMethod).toBe('closing-refs');
        }
        // SC-001 fall-through spy: only Tier 1 was queried.
        expect(calls).toHaveLength(1);
      });
    });

    describe('state normalization', () => {
      it('normalizes lowercase state to uppercase', async () => {
        const { runner } = queuedRunner([
          emptyTier1,
          tier2Or3Response([{
            number: 1,
            url: 'u',
            state: 'open',
            isDraft: false,
            headRefName: 'h',
          }]),
        ]);
        const wrapper = new GhCliWrapper(runner);
        const result = await wrapper.resolveIssueToPRRef('o/r', 1);
        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') {
          expect(result.ref.state).toBe('OPEN');
        }
      });
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
        headRepositoryOwner: null,
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

    it('surfaces headRepositoryOwner for same-owner, fork, and deleted head repo (#859)', async () => {
      const baseRaw = {
        number: 1,
        title: 't',
        url: 'u',
        baseRefName: 'develop',
        headRefName: 'h',
        body: '',
        author: null,
        state: 'OPEN',
        isDraft: false,
        labels: [],
      };

      // Same-owner PR — headRepositoryOwner.login === base owner.
      {
        const { runner } = queuedRunner([
          {
            stdout: JSON.stringify({
              ...baseRaw,
              headRepositoryOwner: { login: 'acme' },
            }),
          },
          { stdout: '' },
        ]);
        const wrapper = new GhCliWrapper(runner);
        const pr = await wrapper.getPullRequestDetail('acme/repo', 1);
        expect(pr.headRepositoryOwner).toBe('acme');
      }

      // Fork PR — headRepositoryOwner.login is a different account.
      {
        const { runner } = queuedRunner([
          {
            stdout: JSON.stringify({
              ...baseRaw,
              headRepositoryOwner: { login: 'contributor42' },
            }),
          },
          { stdout: '' },
        ]);
        const wrapper = new GhCliWrapper(runner);
        const pr = await wrapper.getPullRequestDetail('acme/repo', 1);
        expect(pr.headRepositoryOwner).toBe('contributor42');
      }

      // Deleted head repo — headRepositoryOwner is null.
      {
        const { runner } = queuedRunner([
          {
            stdout: JSON.stringify({
              ...baseRaw,
              headRepositoryOwner: null,
            }),
          },
          { stdout: '' },
        ]);
        const wrapper = new GhCliWrapper(runner);
        const pr = await wrapper.getPullRequestDetail('acme/repo', 1);
        expect(pr.headRepositoryOwner).toBeNull();
      }
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

  describe('deleteHeadRef', () => {
    it('exit 0 → { outcome: "deleted" }', async () => {
      const { runner, calls } = stubRunner({ exitCode: 0, stdout: '', stderr: '' });
      const wrapper = new GhCliWrapper(runner);
      const result = await wrapper.deleteHeadRef('o/r', 'feature/x');
      expect(result).toEqual({ outcome: 'deleted' });
      const args = calls[0]?.args ?? [];
      expect(args).toEqual([
        'api',
        '-X',
        'DELETE',
        'repos/o/r/git/refs/heads/feature/x',
      ]);
    });

    it('exit 1 + HTTP 422 stderr → { outcome: "already-gone" }', async () => {
      const { runner } = stubRunner({
        exitCode: 1,
        stdout: '',
        stderr:
          'HTTP 422: Reference does not exist (https://api.github.com/repos/o/r/git/refs/heads/feature%2Fx)\n{"message":"Reference does not exist","documentation_url":"https://docs.github.com/rest/git/refs#delete-a-reference","status":"422"}',
      });
      const wrapper = new GhCliWrapper(runner);
      const result = await wrapper.deleteHeadRef('o/r', 'feature/x');
      expect(result).toEqual({ outcome: 'already-gone' });
    });

    it('exit 1 + HTTP 404 stderr → { outcome: "already-gone" }', async () => {
      const { runner } = stubRunner({
        exitCode: 1,
        stdout: '',
        stderr:
          'HTTP 404: Not Found (https://api.github.com/repos/o/r/git/refs/heads/gone)',
      });
      const wrapper = new GhCliWrapper(runner);
      const result = await wrapper.deleteHeadRef('o/r', 'gone');
      expect(result).toEqual({ outcome: 'already-gone' });
    });

    it('exit 1 + arbitrary stderr → { outcome: "delete-failed", stderr }', async () => {
      const { runner } = stubRunner({
        exitCode: 1,
        stdout: '',
        stderr: 'HTTP 403: Resource not accessible by integration',
      });
      const wrapper = new GhCliWrapper(runner);
      const result = await wrapper.deleteHeadRef('o/r', 'feature/x');
      expect(result).toEqual({
        outcome: 'delete-failed',
        stderr: 'HTTP 403: Resource not accessible by integration',
      });
    });

    it('throws on malformed repo', async () => {
      const { runner } = stubRunner();
      const wrapper = new GhCliWrapper(runner);
      await expect(wrapper.deleteHeadRef('badrepo', 'x')).rejects.toThrow(
        /owner\/name/,
      );
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
