import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/actions/cli-utils.js', () => ({
  executeCommand: vi.fn(),
  parseJSONSafe: vi.fn((input: string) => {
    try { return JSON.parse(input); } catch { return null; }
  }),
}));

import { executeCommand } from '../../../../src/actions/cli-utils.js';
import { GhCliGitHubClient, GhAuthError } from '../../../../src/actions/github/client/gh-cli.js';

const mockExecuteCommand = vi.mocked(executeCommand);

describe('GhCliGitHubClient.getPRReviewThreads', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  function graphqlResponse(threads: Array<{
    isResolved: boolean;
    comments: Array<{
      databaseId: number;
      body?: string;
      path?: string | null;
      line?: number | null;
      createdAt?: string;
      updatedAt?: string;
      author?: { login: string } | null;
      authorAssociation?: string | null;
      replyTo?: { databaseId: number } | null;
    }>;
  }>) {
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: threads.map(t => ({
                isResolved: t.isResolved,
                comments: {
                  nodes: t.comments.map(c => ({
                    databaseId: c.databaseId,
                    body: c.body ?? `placeholder body ${c.databaseId}`,
                    path: c.path ?? null,
                    line: c.line ?? null,
                    createdAt: c.createdAt ?? '2026-07-08T00:00:00Z',
                    updatedAt: c.updatedAt ?? '2026-07-08T00:00:00Z',
                    author: c.author ?? { login: 'reviewer' },
                    authorAssociation: c.authorAssociation ?? 'MEMBER',
                    replyTo: c.replyTo ?? null,
                  })),
                },
              })),
            },
          },
        },
      },
    });
  }

  it('maps mixed resolved/unresolved threads correctly', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: graphqlResponse([
        { isResolved: true, comments: [{ databaseId: 100 }] },
        { isResolved: false, comments: [{ databaseId: 200 }, { databaseId: 201, replyTo: { databaseId: 200 } }] },
      ]),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const threads = await client.getPRReviewThreads('o', 'r', 42);

    expect(threads.length).toBe(2);
    expect(threads[0]).toMatchObject({ rootCommentId: 100, isResolved: true });
    expect(threads[0]!.comments.length).toBe(1);
    expect(threads[0]!.comments[0]!.resolved).toBeUndefined();
    expect(threads[1]).toMatchObject({ rootCommentId: 200, isResolved: false });
    expect(threads[1]!.comments.length).toBe(2);
    expect(threads[1]!.comments[1]!.in_reply_to_id).toBe(200);
  });

  it('returns [] when reviewThreads.nodes is empty', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: graphqlResponse([]),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const threads = await client.getPRReviewThreads('o', 'r', 42);
    expect(threads).toEqual([]);
  });

  it('returns [] when the payload structure is missing pullRequest', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ data: { repository: null } }),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const threads = await client.getPRReviewThreads('o', 'r', 42);
    expect(threads).toEqual([]);
  });

  it('throws GhAuthError(401) on HTTP 401', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)',
    });

    const client = new GhCliGitHubClient('/tmp');
    try {
      await client.getPRReviewThreads('o', 'r', 42);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GhAuthError);
      expect((err as GhAuthError).statusCode).toBe(401);
    }
  });

  it('throws GhAuthError(403) on HTTP 403', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 403: Resource not accessible by integration',
    });

    const client = new GhCliGitHubClient('/tmp');
    try {
      await client.getPRReviewThreads('o', 'r', 42);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GhAuthError);
      expect((err as GhAuthError).statusCode).toBe(403);
    }
  });

  it('throws a generic Error on 5xx', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 500: internal server error',
    });

    const client = new GhCliGitHubClient('/tmp');
    await expect(client.getPRReviewThreads('o', 'r', 42))
      .rejects.toThrow(/Failed to fetch review threads/);
    await expect(client.getPRReviewThreads('o', 'r', 42))
      .rejects.not.toBeInstanceOf(GhAuthError);
  });

  it('leaves in_reply_to_id undefined when replyTo is null on root comment', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: graphqlResponse([
        { isResolved: false, comments: [{ databaseId: 300, replyTo: null }] },
      ]),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const threads = await client.getPRReviewThreads('o', 'r', 42);
    expect(threads[0]!.comments[0]!.in_reply_to_id).toBeUndefined();
  });

  it('sets in_reply_to_id when replyTo has databaseId', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: graphqlResponse([
        {
          isResolved: false,
          comments: [
            { databaseId: 400 },
            { databaseId: 401, replyTo: { databaseId: 400 } },
          ],
        },
      ]),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const threads = await client.getPRReviewThreads('o', 'r', 42);
    expect(threads[0]!.comments[0]!.in_reply_to_id).toBeUndefined();
    expect(threads[0]!.comments[1]!.in_reply_to_id).toBe(400);
  });

  it('does not populate Comment.resolved on emitted comments', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: graphqlResponse([
        { isResolved: true, comments: [{ databaseId: 500 }] },
        { isResolved: false, comments: [{ databaseId: 600 }] },
      ]),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const threads = await client.getPRReviewThreads('o', 'r', 42);
    for (const t of threads) {
      for (const c of t.comments) {
        expect(c.resolved).toBeUndefined();
      }
    }
  });
});
