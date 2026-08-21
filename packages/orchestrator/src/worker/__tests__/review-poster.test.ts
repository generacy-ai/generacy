/**
 * #1125 T019 — ReviewPoster unit tests.
 *
 * Pins the once-per-round COMMENT-event review submission (US1) and the
 * cross-round thread resolution (US4) against a mock GitHubClient + a fake
 * findings artifact. Covers SC-001 (event COMMENT, never REQUEST_CHANGES),
 * FR-002/002a (no finding dropped — diffable→inline, else body), FR-004
 * (advisory visually distinct), FR-009/SC-005 (resolve only `resolved`
 * findings by marker), and FR-010 (per-round dedupe).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { GitHubClient, Review, ReviewThread } from '@generacy-ai/workflow-engine';
import {
  ReviewPoster,
  reviewBodyMarker,
  findingMarker,
} from '../review-poster.js';
import type { FindingsArtifact } from '../review-findings-artifact.js';
import type { Logger } from '../types.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

// A file whose patch makes RIGHT-side lines 1-4 diffable.
const DIFFABLE_FILE = {
  filename: 'src/a.ts',
  status: 'modified',
  patch: '@@ -1,3 +1,4 @@\n line1\n+line2\n line3\n+line4',
};

function makeGithub(overrides: Partial<Record<keyof GitHubClient, unknown>> = {}) {
  return {
    listReviews: vi.fn().mockResolvedValue([]),
    listPullRequestFiles: vi.fn().mockResolvedValue([DIFFABLE_FILE]),
    createReview: vi.fn().mockResolvedValue(undefined),
    getPRReviewThreads: vi.fn().mockResolvedValue([]),
    resolveReviewThread: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitHubClient;
}

function makePoster(github: GitHubClient) {
  return new ReviewPoster({
    github,
    owner: 'o',
    repo: 'r',
    getPrNumber: () => 7,
    logger: mockLogger,
  });
}

describe('ReviewPoster.postRound', () => {
  let github: GitHubClient;

  beforeEach(() => {
    github = makeGithub();
  });

  it('submits exactly one COMMENT-event review per round (SC-001, US1 AC5)', async () => {
    const artifact: FindingsArtifact = {
      verdict: 'changes-required',
      findings: [{ marker: 'm1', text: 'fix this', severity: 'blocking', anchor: { file: 'src/a.ts', line: 2 } }],
    };

    await makePoster(github).postRound(artifact, 1);

    expect(github.createReview).toHaveBeenCalledTimes(1);
    const input = (github.createReview as ReturnType<typeof vi.fn>).mock.calls[0]![3];
    expect(input.event).toBe('COMMENT');
    expect(input.event).not.toBe('REQUEST_CHANGES');
  });

  it('routes a diffable anchor to an inline comment (FR-002)', async () => {
    const artifact: FindingsArtifact = {
      verdict: 'changes-required',
      findings: [{ marker: 'inline1', text: 'inline finding', severity: 'blocking', anchor: { file: 'src/a.ts', line: 2 } }],
    };

    await makePoster(github).postRound(artifact, 1);

    const input = (github.createReview as ReturnType<typeof vi.fn>).mock.calls[0]![3];
    expect(input.comments).toHaveLength(1);
    expect(input.comments[0]).toMatchObject({ path: 'src/a.ts', line: 2, side: 'RIGHT' });
    expect(input.comments[0].body).toContain(findingMarker('inline1'));
    // Inline finding is NOT duplicated into the body.
    expect(input.body).not.toContain('inline finding');
  });

  it('falls back to the body for undiffable and anchorless findings — nothing dropped (FR-002a)', async () => {
    const artifact: FindingsArtifact = {
      verdict: 'changes-required',
      findings: [
        // File not in the diff → body fallback, keeps its intended file:line.
        { marker: 'b1', text: 'undiffable file', severity: 'blocking', anchor: { file: 'src/other.ts', line: 5 } },
        // Line not in the diff → body fallback.
        { marker: 'b2', text: 'undiffable line', severity: 'advisory', anchor: { file: 'src/a.ts', line: 99 } },
        // No anchor at all → body.
        { marker: 'b3', text: 'no anchor', severity: 'blocking' },
      ],
    };

    await makePoster(github).postRound(artifact, 1);

    const input = (github.createReview as ReturnType<typeof vi.fn>).mock.calls[0]![3];
    expect(input.comments).toHaveLength(0);
    expect(input.body).toContain('undiffable file');
    expect(input.body).toContain('`src/other.ts:5`');
    expect(input.body).toContain('undiffable line');
    expect(input.body).toContain('no anchor');
  });

  it('stamps the body with the round marker and a human Round header (SC-004, SC-006)', async () => {
    const artifact: FindingsArtifact = { verdict: 'clean', findings: [] };

    await makePoster(github).postRound(artifact, 3);

    const input = (github.createReview as ReturnType<typeof vi.fn>).mock.calls[0]![3];
    expect(input.body).toContain(reviewBodyMarker(3));
    expect(input.body).toContain('Round 3');
  });

  it('renders advisory findings visually distinct from blocking (FR-004)', async () => {
    const artifact: FindingsArtifact = {
      verdict: 'changes-required',
      findings: [
        { marker: 'adv', text: 'a nit', severity: 'advisory' },
        { marker: 'blk', text: 'a bug', severity: 'blocking' },
      ],
    };

    await makePoster(github).postRound(artifact, 1);

    const input = (github.createReview as ReturnType<typeof vi.fn>).mock.calls[0]![3];
    expect(input.body).toContain('🔵 Advisory (non-blocking)');
    expect(input.body).toContain('🔴 Blocking');
  });

  it('does not re-post a round whose body marker already exists (FR-010)', async () => {
    const existing: Review[] = [
      { id: 1, user: { login: 'gen' }, body: reviewBodyMarker(1), state: 'COMMENTED', submittedAt: 't' },
    ];
    github = makeGithub({ listReviews: vi.fn().mockResolvedValue(existing) });
    const artifact: FindingsArtifact = { verdict: 'clean', findings: [] };

    await makePoster(github).postRound(artifact, 1);

    expect(github.createReview).not.toHaveBeenCalled();
  });

  it('never throws — a createReview failure is swallowed (FR-008)', async () => {
    github = makeGithub({ createReview: vi.fn().mockRejectedValue(new Error('boom')) });
    const artifact: FindingsArtifact = { verdict: 'clean', findings: [] };

    await expect(makePoster(github).postRound(artifact, 1)).resolves.toBeUndefined();
  });
});

describe('ReviewPoster.resolveResolvedThreads', () => {
  function threadWithMarker(id: string, marker: string, isResolved = false): ReviewThread {
    return {
      id,
      rootCommentId: 1,
      isResolved,
      comments: [
        { id: 1, body: `${findingMarker(marker)}\nsome text`, author: 'gen', created_at: 't', updated_at: 't' },
      ],
    };
  }

  it('resolves only threads for findings marked resolved, matched by marker (FR-009, SC-005)', async () => {
    const threads = [threadWithMarker('T_A', 'mA'), threadWithMarker('T_B', 'mB')];
    const github = makeGithub({ getPRReviewThreads: vi.fn().mockResolvedValue(threads) });
    const artifact: FindingsArtifact = {
      verdict: 'changes-required',
      findings: [
        { marker: 'mA', text: 'done', severity: 'blocking', resolved: true },
        { marker: 'mB', text: 'still open', severity: 'blocking', resolved: false },
      ],
    };

    await makePoster(github).resolveResolvedThreads(artifact);

    expect(github.resolveReviewThread).toHaveBeenCalledTimes(1);
    expect(github.resolveReviewThread).toHaveBeenCalledWith('T_A');
  });

  it('skips already-resolved threads', async () => {
    const threads = [threadWithMarker('T_A', 'mA', true)];
    const github = makeGithub({ getPRReviewThreads: vi.fn().mockResolvedValue(threads) });
    const artifact: FindingsArtifact = {
      verdict: 'changes-required',
      findings: [{ marker: 'mA', text: 'done', severity: 'blocking', resolved: true }],
    };

    await makePoster(github).resolveResolvedThreads(artifact);

    expect(github.resolveReviewThread).not.toHaveBeenCalled();
  });

  it('isolates a single resolve failure — the others still resolve (FR-008, US4 AC3)', async () => {
    const threads = [threadWithMarker('T_A', 'mA'), threadWithMarker('T_B', 'mB')];
    const resolveReviewThread = vi
      .fn()
      .mockRejectedValueOnce(new Error('first fails'))
      .mockResolvedValueOnce(undefined);
    const github = makeGithub({
      getPRReviewThreads: vi.fn().mockResolvedValue(threads),
      resolveReviewThread,
    });
    const artifact: FindingsArtifact = {
      verdict: 'changes-required',
      findings: [
        { marker: 'mA', text: 'done', severity: 'blocking', resolved: true },
        { marker: 'mB', text: 'done', severity: 'blocking', resolved: true },
      ],
    };

    await makePoster(github).resolveResolvedThreads(artifact);

    expect(resolveReviewThread).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when no findings are resolved', async () => {
    const github = makeGithub();
    const artifact: FindingsArtifact = {
      verdict: 'changes-required',
      findings: [{ marker: 'mA', text: 'x', severity: 'blocking' }],
    };

    await makePoster(github).resolveResolvedThreads(artifact);

    expect(github.getPRReviewThreads).not.toHaveBeenCalled();
  });
});
