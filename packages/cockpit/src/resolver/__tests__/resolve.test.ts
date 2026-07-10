import { describe, expect, it } from 'vitest';
import { resolveEpic } from '../resolve.js';
import { LoudResolverError } from '../errors.js';
import type {
  CheckRunSummary,
  GhWrapper,
  Issue,
  ListIssuesOptions,
  MergeResult,
  PullRequestDetail,
  PullRequestRefResolution,
  PullRequestSummary,
  RequiredChecksResult,
} from '../../gh/wrapper.js';

class MockGhWrapper implements GhWrapper {
  public calls: Array<{ repo: string; number: number }> = [];
  constructor(
    private readonly getIssueImpl: (repo: string, n: number) => Promise<Issue>,
  ) {}
  async listIssues(_q: string, _o?: ListIssuesOptions): Promise<Issue[]> {
    throw new Error('not used');
  }
  async getIssue(repo: string, number: number): Promise<Issue> {
    this.calls.push({ repo, number });
    return this.getIssueImpl(repo, number);
  }
  async addLabels(): Promise<void> {}
  async removeLabels(): Promise<void> {}
  async getPullRequestCheckRuns(): Promise<CheckRunSummary[]> {
    return [];
  }
  async resolveIssueToPR(): Promise<number | null> {
    return null;
  }
  async getPullRequest(): Promise<PullRequestSummary> {
    throw new Error('not used');
  }
  async resolveIssueToPRRef(): Promise<PullRequestRefResolution> {
    return { kind: 'unresolved' };
  }
  async getPullRequestDetail(): Promise<PullRequestDetail> {
    throw new Error('not used');
  }
  async mergePullRequest(): Promise<MergeResult> {
    throw new Error('not used');
  }
  async getRequiredCheckNames(): Promise<RequiredChecksResult> {
    throw new Error('not used');
  }
}

function makeIssue(overrides: Partial<Issue> & { number: number }): Issue {
  return {
    title: `Issue #${overrides.number}`,
    state: 'OPEN',
    stateReason: null,
    labels: [],
    url: `https://github.com/owner/repo/issues/${overrides.number}`,
    body: '',
    createdAt: '',
    ...overrides,
  };
}

describe('resolveEpic', () => {
  it('happy path returns ResolvedEpic with sorted repos and body hash', async () => {
    const body = [
      '### S2',
      '- [ ] owner/repo-b#3',
      '- [ ] owner/repo-a#1',
      '### S3',
      '- [ ] owner/repo-a#2',
    ].join('\n');
    const gh = new MockGhWrapper(async (repo, n) => makeIssue({ number: n, body }));
    const result = await resolveEpic({ epicRef: 'owner/repo-a#42', gh });
    expect(result.epic).toEqual({ repo: 'owner/repo-a', number: 42 });
    expect(result.repos).toEqual(['owner/repo-a', 'owner/repo-b']);
    expect(result.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.parsed.phases).toHaveLength(2);
    expect(gh.calls).toEqual([{ repo: 'owner/repo-a', number: 42 }]);
  });

  it('throws INVALID_EPIC_REF on malformed --epic', async () => {
    const gh = new MockGhWrapper(async () => makeIssue({ number: 1, body: '' }));
    try {
      await resolveEpic({ epicRef: 'not-a-ref', gh });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LoudResolverError);
      expect((err as LoudResolverError).code).toBe('INVALID_EPIC_REF');
    }
  });

  it('throws GH_FETCH_FAILED when getIssue throws', async () => {
    const gh = new MockGhWrapper(async () => {
      throw new Error('boom');
    });
    try {
      await resolveEpic({ epicRef: 'owner/repo#1', gh });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LoudResolverError);
      const loud = err as LoudResolverError;
      expect(loud.code).toBe('GH_FETCH_FAILED');
      expect(loud.message).toContain('boom');
    }
  });

  it('throws NO_PHASE_HEADINGS when body has no ### headings', async () => {
    const gh = new MockGhWrapper(async () => makeIssue({ number: 1, body: 'no headings\n- [ ] owner/repo#1' }));
    try {
      await resolveEpic({ epicRef: 'owner/repo#42', gh });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LoudResolverError);
      expect((err as LoudResolverError).code).toBe('NO_PHASE_HEADINGS');
      expect((err as LoudResolverError).message).toContain('### <phase>');
    }
  });

  it('throws NO_REFS when phases exist but contain no refs', async () => {
    const body = '### S1\n### S2\n';
    const gh = new MockGhWrapper(async () => makeIssue({ number: 1, body }));
    try {
      await resolveEpic({ epicRef: 'owner/repo#42', gh });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LoudResolverError);
      expect((err as LoudResolverError).code).toBe('NO_REFS');
    }
  });

  it('forwards parser warnings to options.logger.warn', async () => {
    const body = ['### S1', '- [ ] #8', '- [ ] owner/repo#1'].join('\n');
    const gh = new MockGhWrapper(async () => makeIssue({ number: 1, body }));
    const warnings: string[] = [];
    await resolveEpic({
      epicRef: 'owner/repo#42',
      gh,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('#8');
  });
});
