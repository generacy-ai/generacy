// #1130 finding #4 — parseExternalFeedback must exclude engine-authored
// comments/review-bodies, not just filter by trust. The engine bot IS a trusted
// author, so a pure trust filter re-seeds the engine's own already-surfaced
// review threads into the remediate loop alongside the genuine human ask.
import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient, ReviewThread, Review } from '@generacy-ai/workflow-engine';
import type { Logger } from '../types.js';
import { parseExternalFeedback } from '../pr-feedback-parser.js';

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
} as unknown as Logger;

function makeGithub(threads: ReviewThread[], reviews: Review[] = []): GitHubClient {
  return {
    getPRReviewThreads: vi.fn().mockResolvedValue(threads),
    listReviews: vi.fn().mockResolvedValue(reviews),
  } as unknown as GitHubClient;
}

const baseParams = {
  owner: 'owner',
  repo: 'repo',
  prNumber: 10,
  checkoutPath: '/tmp/does-not-matter',
  logger,
};

describe('parseExternalFeedback engine-authored exclusion (#1130 finding #4)', () => {
  it('drops an all-engine thread and keeps the human comment in a mixed thread', async () => {
    const threads = [
      {
        id: 'T_ENGINE',
        rootCommentId: 601,
        isResolved: false,
        comments: [
          {
            id: 601,
            body: '<!-- generacy-finding:abc -->\nEngine inline finding',
            author: 'cluster-bot',
            authorAssociation: 'MEMBER',
            created_at: '',
            updated_at: '',
          },
        ],
      },
      {
        id: 'T_MIXED',
        rootCommentId: 700,
        isResolved: false,
        comments: [
          {
            id: 700,
            body: '<!-- generacy-finding:def -->\nEngine reply',
            author: 'cluster-bot',
            authorAssociation: 'MEMBER',
            created_at: '',
            updated_at: '',
          },
          {
            id: 701,
            body: 'Human: please also handle the null case',
            author: 'maintainer',
            authorAssociation: 'MEMBER',
            created_at: '',
            updated_at: '',
            path: 'src/app.ts',
            line: 12,
          },
        ],
      },
    ] as unknown as ReviewThread[];

    const findings = await parseExternalFeedback({ ...baseParams, github: makeGithub(threads) });

    // Only the human comment survives — no engine finding is re-seeded.
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: '701', author: 'maintainer' });
    expect(findings[0]!.body).toContain('null case');
  });

  it('excludes an engine-authored review body', async () => {
    const reviews = [
      {
        id: 900,
        state: 'COMMENTED',
        body: '<!-- generacy-engine-review round=2 -->\n\n## Engine review — Round 2',
        user: { login: 'cluster-bot' },
        submittedAt: '',
        authorAssociation: 'MEMBER',
      },
      {
        id: 901,
        state: 'CHANGES_REQUESTED',
        body: 'Human review: rename this function',
        user: { login: 'maintainer' },
        submittedAt: '',
        authorAssociation: 'MEMBER',
      },
    ] as unknown as Review[];

    const findings = await parseExternalFeedback({
      ...baseParams,
      github: makeGithub([], reviews),
    });

    // Only the human review body survives.
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: '901', author: 'maintainer' });
    expect(findings[0]!.body).toContain('rename this function');
  });

  it('a `> `-quoted engine marker does NOT exclude a human comment', async () => {
    const threads = [
      {
        id: 'T_QUOTE',
        rootCommentId: 800,
        isResolved: false,
        comments: [
          {
            id: 800,
            body: '> <!-- generacy-finding:abc -->\nI disagree with this finding',
            author: 'maintainer',
            authorAssociation: 'MEMBER',
            created_at: '',
            updated_at: '',
          },
        ],
      },
    ] as unknown as ReviewThread[];

    const findings = await parseExternalFeedback({ ...baseParams, github: makeGithub(threads) });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: '800', author: 'maintainer' });
  });
});
