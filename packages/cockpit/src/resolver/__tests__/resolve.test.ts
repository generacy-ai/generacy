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
  async updateIssueBody(): Promise<void> {
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

  it('flat-list body (no ### headings, has task-list refs) resolves successfully (#935)', async () => {
    const body = 'preamble prose\n- [ ] owner/repo#1\n- [ ] owner/repo#2';
    const gh = new MockGhWrapper(async () => makeIssue({ number: 1, body }));
    const result = await resolveEpic({ epicRef: 'owner/repo#42', gh });
    expect(result.parsed.phases).toEqual([]);
    expect(result.parsed.adhocRefs).toEqual([
      { repo: 'owner/repo', number: 1 },
      { repo: 'owner/repo', number: 2 },
    ]);
    expect(result.parsed.allRefs).toEqual([
      { repo: 'owner/repo', number: 1 },
      { repo: 'owner/repo', number: 2 },
    ]);
  });

  it('phased body with `## Ad-hoc` section coexists — phases and adhocRefs both populated (#935)', async () => {
    const body = [
      '### Phase 1',
      '- [ ] owner/repo#1',
      '## Ad-hoc',
      '- [ ] owner/repo#9',
    ].join('\n');
    const gh = new MockGhWrapper(async () => makeIssue({ number: 1, body }));
    const result = await resolveEpic({ epicRef: 'owner/repo#42', gh });
    expect(result.parsed.phases).toHaveLength(1);
    expect(result.parsed.adhocRefs).toEqual([{ repo: 'owner/repo', number: 9 }]);
  });

  it('does not throw NO_PHASE_HEADINGS at runtime any more (#935)', async () => {
    const gh = new MockGhWrapper(async () => makeIssue({ number: 1, body: '- [ ] owner/repo#1' }));
    const result = await resolveEpic({ epicRef: 'owner/repo#42', gh });
    expect(result.parsed.phases).toEqual([]);
    expect(result.parsed.allRefs).toEqual([{ repo: 'owner/repo', number: 1 }]);
  });

  it('empty body still throws NO_REFS (#935 preserved)', async () => {
    const gh = new MockGhWrapper(async () => makeIssue({ number: 1, body: '' }));
    try {
      await resolveEpic({ epicRef: 'owner/repo#42', gh });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LoudResolverError);
      expect((err as LoudResolverError).code).toBe('NO_REFS');
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
