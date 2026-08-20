// #1130 finding #1(a) — resolveExternalFeedbackThreads.
//
// On loop convergence the address-pr-feedback route resolves the seeded external
// inline threads (invite-to-reopen reply + resolve) so the monitor's next poll
// sees no live external feedback and does not re-enqueue (the convergence half of
// the runaway fix). Matches by rootCommentId, skips resolved/all-engine threads,
// best-effort throughout.
import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient, ReviewThread } from '@generacy-ai/workflow-engine';
import type { Logger } from '../types.js';
import { resolveExternalFeedbackThreads } from '../external-feedback-resolver.js';

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
} as unknown as Logger;

function makeGithub(threads: ReviewThread[]): GitHubClient & {
  replyToPRComment: ReturnType<typeof vi.fn>;
  resolveReviewThread: ReturnType<typeof vi.fn>;
} {
  return {
    getPRReviewThreads: vi.fn().mockResolvedValue(threads),
    replyToPRComment: vi.fn().mockResolvedValue({}),
    resolveReviewThread: vi.fn().mockResolvedValue(undefined),
  } as unknown as GitHubClient & {
    replyToPRComment: ReturnType<typeof vi.fn>;
    resolveReviewThread: ReturnType<typeof vi.fn>;
  };
}

const base = { owner: 'owner', repo: 'repo', prNumber: 10, headShortSha: 'abc1234', logger };

describe('resolveExternalFeedbackThreads (#1130 finding #1(a))', () => {
  it('no-ops without fetching when there are no target ids', async () => {
    const github = makeGithub([]);
    await resolveExternalFeedbackThreads({ ...base, github, rootCommentIds: [] });
    expect(github.getPRReviewThreads).not.toHaveBeenCalled();
  });

  it('resolves matching unresolved external threads with an invite-to-reopen reply', async () => {
    const threads = [
      {
        id: 'T1',
        rootCommentId: 101,
        isResolved: false,
        comments: [{ id: 101, body: 'please change this', author: 'maintainer', authorAssociation: 'MEMBER', created_at: '', updated_at: '' }],
      },
    ] as unknown as ReviewThread[];
    const github = makeGithub(threads);

    await resolveExternalFeedbackThreads({ ...base, github, rootCommentIds: [101] });

    expect(github.replyToPRComment).toHaveBeenCalledWith(
      'owner', 'repo', 10, 101, expect.stringContaining('Re-open this thread'),
    );
    expect(github.resolveReviewThread).toHaveBeenCalledWith('T1');
  });

  it('skips already-resolved threads and non-target threads', async () => {
    const threads = [
      {
        id: 'T_RESOLVED',
        rootCommentId: 101,
        isResolved: true,
        comments: [{ id: 101, body: 'x', author: 'maintainer', authorAssociation: 'MEMBER', created_at: '', updated_at: '' }],
      },
      {
        id: 'T_OTHER',
        rootCommentId: 999,
        isResolved: false,
        comments: [{ id: 999, body: 'unrelated', author: 'maintainer', authorAssociation: 'MEMBER', created_at: '', updated_at: '' }],
      },
    ] as unknown as ReviewThread[];
    const github = makeGithub(threads);

    await resolveExternalFeedbackThreads({ ...base, github, rootCommentIds: [101] });

    expect(github.resolveReviewThread).not.toHaveBeenCalled();
  });

  it('never resolves an all-engine thread even if targeted', async () => {
    const threads = [
      {
        id: 'T_ENGINE',
        rootCommentId: 101,
        isResolved: false,
        comments: [{ id: 101, body: '<!-- generacy-finding:abc -->\nEngine finding', author: 'cluster-bot', authorAssociation: 'MEMBER', created_at: '', updated_at: '' }],
      },
    ] as unknown as ReviewThread[];
    const github = makeGithub(threads);

    await resolveExternalFeedbackThreads({ ...base, github, rootCommentIds: [101] });

    expect(github.resolveReviewThread).not.toHaveBeenCalled();
  });

  it('is best-effort: one resolve failure does not stop the others', async () => {
    const threads = [
      {
        id: 'T1',
        rootCommentId: 101,
        isResolved: false,
        comments: [{ id: 101, body: 'a', author: 'maintainer', authorAssociation: 'MEMBER', created_at: '', updated_at: '' }],
      },
      {
        id: 'T2',
        rootCommentId: 102,
        isResolved: false,
        comments: [{ id: 102, body: 'b', author: 'maintainer', authorAssociation: 'MEMBER', created_at: '', updated_at: '' }],
      },
    ] as unknown as ReviewThread[];
    const github = makeGithub(threads);
    github.resolveReviewThread
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    await expect(
      resolveExternalFeedbackThreads({ ...base, github, rootCommentIds: [101, 102] }),
    ).resolves.toBeUndefined();

    expect(github.resolveReviewThread).toHaveBeenCalledTimes(2);
  });
});
