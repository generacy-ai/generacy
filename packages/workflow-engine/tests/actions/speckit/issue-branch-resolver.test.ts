/**
 * Unit tests for resolveIssueBranch — the canonical branch resolver
 * used by createFeature and PrManager to prevent duplicate branch/PR
 * creation on speckit workflow re-entry (#1043).
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveIssueBranch } from '../../../src/actions/builtin/speckit/lib/issue-branch-resolver.js';
import type { GitHubClient } from '../../../src/actions/github/client/interface.js';
import type { PullRequest } from '../../../src/types/github.js';

interface StubGitHubOptions {
  openPrs?: Array<{ number: number; headRef: string; createdAt: string }>;
  branches?: string[];
  listOpenPullRequestsError?: Error;
  listBranchesError?: Error;
}

function makeGithubStub(options: StubGitHubOptions): GitHubClient {
  const listOpenPullRequests = vi.fn(async () => {
    if (options.listOpenPullRequestsError) throw options.listOpenPullRequestsError;
    const prs = (options.openPrs ?? []).map(
      (o): PullRequest => ({
        number: o.number,
        title: '',
        body: '',
        state: 'open',
        draft: false,
        head: { ref: o.headRef, sha: 'sha', repo: 'owner/repo' },
        base: { ref: 'develop', sha: 'sha', repo: 'owner/repo' },
        labels: [],
        created_at: o.createdAt,
        updated_at: o.createdAt,
      })
    );
    return prs;
  });

  const listBranches = vi.fn(async () => {
    if (options.listBranchesError) throw options.listBranchesError;
    return options.branches ?? [];
  });

  return {
    listOpenPullRequests,
    listBranches,
  } as unknown as GitHubClient;
}

interface StubGitOptions {
  timestamps?: Record<string, number>;
  failedBranches?: Set<string>;
  fetch?: ReturnType<typeof vi.fn>;
}

function makeGitStub(options: StubGitOptions = {}) {
  const timestamps = options.timestamps ?? {};
  const failed = options.failedBranches ?? new Set<string>();
  return {
    fetch: options.fetch ?? vi.fn(async () => undefined),
    raw: vi.fn(async (args: string[]) => {
      // Expect ['log', '-1', '--format=%ct', 'refs/remotes/origin/<branch>']
      const ref = args[args.length - 1];
      const branch = ref?.replace(/^refs\/remotes\/origin\//, '') ?? '';
      if (failed.has(branch)) throw new Error(`git log failed for ${branch}`);
      const ts = timestamps[branch];
      if (ts === undefined) throw new Error(`unknown branch ${branch}`);
      return String(ts) + '\n';
    }),
  } as unknown as import('simple-git').SimpleGit;
}

describe('resolveIssueBranch', () => {
  const owner = 'generacy-ai';
  const repo = 'generacy';

  it('returns null when neither a matching PR nor a matching branch exists', async () => {
    const github = makeGithubStub({ openPrs: [], branches: ['develop', 'main'] });
    const git = makeGitStub();
    const result = await resolveIssueBranch({
      issueNumber: 999,
      owner,
      repo,
      github,
      git,
    });
    expect(result).toBeNull();
  });

  it('returns the sole matching remote branch when no PR exists', async () => {
    const github = makeGithubStub({
      openPrs: [],
      branches: ['develop', '1038-issue-1038'],
    });
    const git = makeGitStub({
      timestamps: { '1038-issue-1038': 1_700_000_000 },
    });
    const result = await resolveIssueBranch({
      issueNumber: 1038,
      owner,
      repo,
      github,
      git,
    });
    expect(result).toEqual({
      branchName: '1038-issue-1038',
      source: 'oldest-remote-branch',
      candidateBranchCount: 1,
      candidatePrCount: 0,
    });
  });

  it('picks the oldest branch when multiple matching branches exist and no PR does', async () => {
    const github = makeGithubStub({
      openPrs: [],
      branches: ['1038-part-cockpit-remote-gates', '1038-issue-1038'],
    });
    const git = makeGitStub({
      timestamps: {
        '1038-issue-1038': 1_700_000_000,
        '1038-part-cockpit-remote-gates': 1_700_500_000,
      },
    });
    const result = await resolveIssueBranch({
      issueNumber: 1038,
      owner,
      repo,
      github,
      git,
    });
    expect(result).toMatchObject({
      branchName: '1038-issue-1038',
      source: 'oldest-remote-branch',
      candidateBranchCount: 2,
      candidatePrCount: 0,
    });
  });

  it('final alphabetical tiebreak when two branches share a commit timestamp', async () => {
    const github = makeGithubStub({
      openPrs: [],
      branches: ['1038-b-slug', '1038-a-slug'],
    });
    const git = makeGitStub({
      timestamps: {
        '1038-a-slug': 1_700_000_000,
        '1038-b-slug': 1_700_000_000,
      },
    });
    const result = await resolveIssueBranch({
      issueNumber: 1038,
      owner,
      repo,
      github,
      git,
    });
    expect(result?.branchName).toBe('1038-a-slug');
  });

  it("chooses the PR's head branch when a PR exists — even if another branch matches", async () => {
    const github = makeGithubStub({
      openPrs: [
        { number: 1039, headRef: '1038-issue-1038', createdAt: '2026-01-01T00:00:00Z' },
      ],
      branches: ['1038-issue-1038', '1038-orphan-branch'],
    });
    const git = makeGitStub({
      timestamps: {
        '1038-issue-1038': 1_700_500_000,
        '1038-orphan-branch': 1_700_000_000, // older, but no PR anchors it
      },
    });
    const result = await resolveIssueBranch({
      issueNumber: 1038,
      owner,
      repo,
      github,
      git,
    });
    expect(result).toEqual({
      branchName: '1038-issue-1038',
      source: 'oldest-open-pr',
      anchoringPrNumber: 1039,
      candidateBranchCount: 2,
      candidatePrCount: 1,
    });
  });

  it('#1038 regression: two matching branches + two open PRs → oldest open PR wins', async () => {
    const github = makeGithubStub({
      openPrs: [
        // #1041 was created ~1 min after #1039 in the real incident
        {
          number: 1041,
          headRef: '1038-part-cockpit-remote-gates',
          createdAt: '2026-01-01T00:01:00Z',
        },
        { number: 1039, headRef: '1038-issue-1038', createdAt: '2026-01-01T00:00:00Z' },
      ],
      branches: ['1038-issue-1038', '1038-part-cockpit-remote-gates'],
    });
    const git = makeGitStub({
      timestamps: {
        '1038-issue-1038': 1_700_000_000,
        '1038-part-cockpit-remote-gates': 1_700_000_060,
      },
    });
    const result = await resolveIssueBranch({
      issueNumber: 1038,
      owner,
      repo,
      github,
      git,
    });
    expect(result).toEqual({
      branchName: '1038-issue-1038',
      source: 'oldest-open-pr',
      anchoringPrNumber: 1039,
      candidateBranchCount: 2,
      candidatePrCount: 2,
    });
  });

  it('filter regex is anchored: issue 123 does NOT match branches like 1234-*', async () => {
    const github = makeGithubStub({
      openPrs: [
        { number: 200, headRef: '1234-something', createdAt: '2026-01-01T00:00:00Z' },
      ],
      branches: ['1234-something'],
    });
    const git = makeGitStub({
      timestamps: { '1234-something': 1_700_000_000 },
    });
    const result = await resolveIssueBranch({
      issueNumber: 123,
      owner,
      repo,
      github,
      git,
    });
    expect(result).toBeNull();
  });

  it('swallows listOpenPullRequests errors and falls back to branch enumeration', async () => {
    const warn = vi.fn();
    const github = makeGithubStub({
      listOpenPullRequestsError: new Error('gh boom'),
      branches: ['1038-issue-1038'],
    });
    const git = makeGitStub({ timestamps: { '1038-issue-1038': 1_700_000_000 } });
    const result = await resolveIssueBranch({
      issueNumber: 1038,
      owner,
      repo,
      github,
      git,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    });
    expect(result).toMatchObject({
      branchName: '1038-issue-1038',
      source: 'oldest-remote-branch',
    });
    expect(warn).toHaveBeenCalledWith(
      'issue-branch-resolver-pr-list-failed',
      expect.objectContaining({ event: 'issue-branch-resolver-pr-list-failed', issueNumber: 1038 })
    );
  });

  it('returns null (and does not throw) when both enumeration calls fail', async () => {
    const warn = vi.fn();
    const github = makeGithubStub({
      listOpenPullRequestsError: new Error('gh pr list boom'),
      listBranchesError: new Error('gh api branches boom'),
    });
    const git = makeGitStub();
    const result = await resolveIssueBranch({
      issueNumber: 1038,
      owner,
      repo,
      github,
      git,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      'issue-branch-resolver-pr-list-failed',
      expect.any(Object)
    );
    expect(warn).toHaveBeenCalledWith(
      'issue-branch-resolver-branch-list-failed',
      expect.any(Object)
    );
  });

  it('#1043 Finding 4: fetches candidate refs before reading commit timestamps', async () => {
    // Branches known only via the API have no local remote-tracking ref, so the
    // resolver must fetch the matching refs first — otherwise `git log` throws
    // for every one of them and the oldest-branch tiebreak degrades to
    // alphabetical instead of oldest.
    const fetch = vi.fn(async () => undefined);
    const github = makeGithubStub({
      openPrs: [],
      branches: ['develop', '1038-a-slug', '1038-b-slug'],
    });
    const git = makeGitStub({
      timestamps: {
        '1038-a-slug': 1_700_000_000,
        '1038-b-slug': 1_700_500_000,
      },
      fetch,
    });

    const result = await resolveIssueBranch({
      issueNumber: 1038,
      owner,
      repo,
      github,
      git,
    });

    // Fetch requested for the two matching refs (non-matching `develop` excluded).
    expect(fetch).toHaveBeenCalledWith([
      'origin',
      '+refs/heads/1038-a-slug:refs/remotes/origin/1038-a-slug',
      '+refs/heads/1038-b-slug:refs/remotes/origin/1038-b-slug',
    ]);
    // And the oldest (by real timestamp) still wins.
    expect(result?.branchName).toBe('1038-a-slug');
  });

  it('tolerates a fetch failure and falls back to per-ref timestamp reads', async () => {
    const warn = vi.fn();
    const fetch = vi.fn(async () => {
      throw new Error('fetch boom');
    });
    const github = makeGithubStub({
      openPrs: [],
      branches: ['1038-a-slug'],
    });
    const git = makeGitStub({
      timestamps: { '1038-a-slug': 1_700_000_000 },
      fetch,
    });

    const result = await resolveIssueBranch({
      issueNumber: 1038,
      owner,
      repo,
      github,
      git,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    });

    expect(result?.branchName).toBe('1038-a-slug');
    expect(warn).toHaveBeenCalledWith(
      'issue-branch-resolver-branch-fetch-failed',
      expect.objectContaining({ event: 'issue-branch-resolver-branch-fetch-failed', issueNumber: 1038 })
    );
  });

  it('per-branch git log failure is tolerated — that branch sorts last', async () => {
    const github = makeGithubStub({
      openPrs: [],
      branches: ['1038-a-slug', '1038-b-slug'],
    });
    const git = makeGitStub({
      timestamps: { '1038-a-slug': 1_700_500_000 },
      failedBranches: new Set(['1038-b-slug']), // b's timestamp treated as +Infinity
    });
    const result = await resolveIssueBranch({
      issueNumber: 1038,
      owner,
      repo,
      github,
      git,
    });
    // a has finite timestamp, b sorts last; a wins.
    expect(result?.branchName).toBe('1038-a-slug');
  });
});
