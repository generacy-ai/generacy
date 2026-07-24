/**
 * Regression tests for #1043: PrManager.ensureDraftPr() must not open a
 * duplicate PR when a canonical `<N>-*` PR already exists on the issue.
 *
 * Mirrors the observed #1038 shape: two `<N>-*` branches, two open PRs
 * (#1039 on `1038-issue-1038`, #1041 on `1038-part-cockpit-remote-gates`),
 * current checkout is the newer branch. Expected: adopt the older PR
 * (#1039), never call createPullRequest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrManager } from '../worker/pr-manager.js';
import type { Logger } from '../worker/types.js';
import type {
  GitHubClient,
  PullRequest,
  ResolvedIssueBranch,
} from '@generacy-ai/workflow-engine';
import * as workflowEngine from '@generacy-ai/workflow-engine';

vi.mock('@generacy-ai/workflow-engine', async (importActual) => {
  const actual = await importActual<typeof workflowEngine>();
  return {
    ...actual,
    resolveIssueBranch: vi.fn(),
    simpleGit: vi.fn(() => ({})),
  };
});

const mockedResolve = vi.mocked(workflowEngine.resolveIssueBranch);

function makeLogger(): Logger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
}

function makePullRequest(overrides: Partial<PullRequest> & Pick<PullRequest, 'number'>): PullRequest {
  return {
    number: overrides.number,
    title: overrides.title ?? '',
    body: overrides.body ?? '',
    state: overrides.state ?? 'open',
    draft: overrides.draft ?? true,
    head: overrides.head ?? { ref: '1038-issue-1038', sha: 'sha', repo: 'owner/repo' },
    base: overrides.base ?? { ref: 'develop', sha: 'sha', repo: 'owner/repo' },
    labels: overrides.labels ?? [],
    created_at: overrides.created_at ?? '2026-01-01T00:00:00Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00Z',
  };
}

interface StubGitHubOptions {
  currentBranch: string;
  prByBranch?: Record<string, PullRequest | null>;
}

function makeGithubStub(options: StubGitHubOptions): GitHubClient {
  return {
    getCurrentBranch: vi.fn(async () => options.currentBranch),
    findPRForBranch: vi.fn(async (_owner: string, _repo: string, branch: string) => {
      const map = options.prByBranch ?? {};
      return map[branch] ?? null;
    }),
    createPullRequest: vi.fn(async () =>
      makePullRequest({ number: 9999, head: { ref: 'never', sha: 'x', repo: 'o/r' } })
    ),
    getDefaultBranch: vi.fn(async () => 'develop'),
    // Unused by the ensureDraftPr paths under test:
    getStatus: vi.fn(),
    stageAll: vi.fn(),
    commit: vi.fn(),
    branchExists: vi.fn(),
    getCommitsBetween: vi.fn(),
    push: vi.fn(),
    listOpenPullRequests: vi.fn(async () => []),
    listBranches: vi.fn(async () => []),
  } as unknown as GitHubClient;
}

describe('PrManager.ensureDraftPr — #1043 dedup guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('#1038 regression: adopts the older PR when resolver reports a mismatch', async () => {
    const github = makeGithubStub({
      currentBranch: '1038-part-cockpit-remote-gates',
      prByBranch: {
        '1038-issue-1038': makePullRequest({
          number: 1039,
          head: { ref: '1038-issue-1038', sha: 'sha1', repo: 'owner/repo' },
        }),
      },
    });
    const logger = makeLogger();

    mockedResolve.mockResolvedValueOnce({
      branchName: '1038-issue-1038',
      source: 'oldest-open-pr',
      anchoringPrNumber: 1039,
      candidateBranchCount: 2,
      candidatePrCount: 2,
    } satisfies ResolvedIssueBranch);

    const pr = new PrManager(github, 'generacy-ai', 'generacy', 1038, logger);
    const url = await (pr as unknown as { ensureDraftPr: () => Promise<string | undefined> }).ensureDraftPr();

    expect(url).toBe('https://github.com/generacy-ai/generacy/pull/1039');
    expect(pr.getPrNumber()).toBe(1039);

    // createPullRequest MUST NOT be called on the mismatch path.
    expect(github.createPullRequest).not.toHaveBeenCalled();

    // Adoption log carries the full mismatch payload.
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'workflow-reentry-branch-mismatch',
        issueNumber: 1038,
        currentBranch: '1038-part-cockpit-remote-gates',
        canonicalBranch: '1038-issue-1038',
        source: 'oldest-open-pr',
        anchoringPrNumber: 1039,
        action: 'adopted',
      }),
      'workflow-reentry-branch-mismatch',
    );
  });

  it('resolver reports mismatch but adoption target has no PR → no-op warn, no createPR', async () => {
    const github = makeGithubStub({
      currentBranch: '1038-part-cockpit-remote-gates',
      prByBranch: {
        // Explicitly no PR at the canonical branch.
        '1038-issue-1038': null,
      },
    });
    const logger = makeLogger();

    mockedResolve.mockResolvedValueOnce({
      branchName: '1038-issue-1038',
      source: 'oldest-remote-branch',
      candidateBranchCount: 2,
      candidatePrCount: 0,
    } satisfies ResolvedIssueBranch);

    const pr = new PrManager(github, 'generacy-ai', 'generacy', 1038, logger);
    const url = await (pr as unknown as { ensureDraftPr: () => Promise<string | undefined> }).ensureDraftPr();

    expect(url).toBeUndefined();
    expect(github.createPullRequest).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'workflow-reentry-branch-mismatch',
        action: 'no-op',
        canonicalBranch: '1038-issue-1038',
      }),
      'workflow-reentry-branch-mismatch',
    );
  });

  it('resolver returns null → existing behavior: findPRForBranch(currentBranch) is reached', async () => {
    const github = makeGithubStub({
      currentBranch: '1038-issue-1038',
      prByBranch: {
        '1038-issue-1038': makePullRequest({
          number: 1039,
          head: { ref: '1038-issue-1038', sha: 'sha1', repo: 'owner/repo' },
        }),
      },
    });
    const logger = makeLogger();

    mockedResolve.mockResolvedValueOnce(null);

    const pr = new PrManager(github, 'generacy-ai', 'generacy', 1038, logger);
    const url = await (pr as unknown as { ensureDraftPr: () => Promise<string | undefined> }).ensureDraftPr();

    expect(url).toBe('https://github.com/generacy-ai/generacy/pull/1039');
    expect(github.createPullRequest).not.toHaveBeenCalled();
    // No mismatch event: canonical equals current.
    const mismatchCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === 'workflow-reentry-branch-mismatch'
    );
    expect(mismatchCalls).toHaveLength(0);
  });

  it('resolver reports canonical === current → treated as null path, no mismatch event', async () => {
    const github = makeGithubStub({
      currentBranch: '1038-issue-1038',
      prByBranch: {
        '1038-issue-1038': makePullRequest({
          number: 1039,
          head: { ref: '1038-issue-1038', sha: 'sha1', repo: 'owner/repo' },
        }),
      },
    });
    const logger = makeLogger();

    mockedResolve.mockResolvedValueOnce({
      branchName: '1038-issue-1038',
      source: 'oldest-open-pr',
      anchoringPrNumber: 1039,
      candidateBranchCount: 1,
      candidatePrCount: 1,
    } satisfies ResolvedIssueBranch);

    const pr = new PrManager(github, 'generacy-ai', 'generacy', 1038, logger);
    const url = await (pr as unknown as { ensureDraftPr: () => Promise<string | undefined> }).ensureDraftPr();

    expect(url).toBe('https://github.com/generacy-ai/generacy/pull/1039');
    expect(github.createPullRequest).not.toHaveBeenCalled();
    const mismatchCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === 'workflow-reentry-branch-mismatch'
    );
    expect(mismatchCalls).toHaveLength(0);
  });
});
