/**
 * Unit tests for GhCliGitHubClient.getIssueCommentsWithViewerAuth (#910).
 *
 * Covers the contract in
 * specs/910-found-during-cockpit-v1/contracts/get-issue-comments-with-viewer-auth.contract.md:
 *   - GraphQL query shape (includes `viewerDidAuthor`)
 *   - Response mapping (databaseId → id, viewerDidAuthor per FR-001)
 *   - HTTP 401 → GhAuthError
 *   - Non-zero exit → generic Error carrying stderr
 *   - No-data-node → []
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../cli-utils.js', () => ({
  executeCommand: vi.fn(),
  parseJSONSafe: vi.fn((input: string) => {
    try { return JSON.parse(input); } catch { return null; }
  }),
}));

import { executeCommand } from '../../../cli-utils.js';
import { GhCliGitHubClient, GhAuthError } from '../gh-cli.js';

const mockExecuteCommand = vi.mocked(executeCommand);

describe('GhCliGitHubClient.getIssueCommentsWithViewerAuth', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  function graphqlResponse(comments: Array<{
    databaseId: number;
    body?: string;
    createdAt?: string;
    updatedAt?: string;
    author?: { login: string } | null;
    authorAssociation?: string | null;
    viewerDidAuthor?: boolean | null;
    omitViewerDidAuthor?: boolean;
  }>) {
    return JSON.stringify({
      data: {
        repository: {
          issue: {
            comments: {
              nodes: comments.map((c) => {
                const node: Record<string, unknown> = {
                  databaseId: c.databaseId,
                  body: c.body ?? `placeholder body ${c.databaseId}`,
                  createdAt: c.createdAt ?? '2026-07-10T00:00:00Z',
                  updatedAt: c.updatedAt ?? '2026-07-10T00:00:00Z',
                  author: 'author' in c ? c.author : { login: 'someone' },
                  authorAssociation: 'authorAssociation' in c ? c.authorAssociation : 'MEMBER',
                };
                if (!c.omitViewerDidAuthor) {
                  node.viewerDidAuthor = 'viewerDidAuthor' in c ? c.viewerDidAuthor : null;
                }
                return node;
              }),
            },
          },
        },
      },
    });
  }

  it('invokes gh api graphql with a query containing viewerDidAuthor (FR-001)', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: graphqlResponse([{ databaseId: 1 }]),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    await client.getIssueCommentsWithViewerAuth('o', 'r', 42);

    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockExecuteCommand.mock.calls[0]!;
    expect(cmd).toBe('gh');
    expect(args).toEqual(expect.arrayContaining(['api', 'graphql']));

    const argsArr = args as string[];
    const queryIdx = argsArr.findIndex((a) => a.startsWith('query='));
    expect(queryIdx).toBeGreaterThanOrEqual(0);
    const queryArg = argsArr[queryIdx]!;
    // Case-sensitive substring per contract Test §"executeGh call".
    expect(queryArg).toContain('viewerDidAuthor');
  });

  it('maps databaseId → id and viewerDidAuthor: true → viewerDidAuthor: true', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: graphqlResponse([
        { databaseId: 100, viewerDidAuthor: true, author: { login: 'cluster' }, authorAssociation: 'NONE' },
      ]),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const comments = await client.getIssueCommentsWithViewerAuth('o', 'r', 42);

    expect(comments.length).toBe(1);
    expect(comments[0]!.id).toBe(100);
    expect(comments[0]!.viewerDidAuthor).toBe(true);
    expect(comments[0]!.author).toBe('cluster');
    expect(comments[0]!.authorAssociation).toBe('NONE');
  });

  it('leaves viewerDidAuthor absent when GraphQL returns null', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: graphqlResponse([{ databaseId: 200, viewerDidAuthor: null }]),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const comments = await client.getIssueCommentsWithViewerAuth('o', 'r', 42);

    expect(comments.length).toBe(1);
    expect('viewerDidAuthor' in comments[0]!).toBe(false);
  });

  it('leaves viewerDidAuthor absent when GraphQL omits the field', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: graphqlResponse([{ databaseId: 201, omitViewerDidAuthor: true }]),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const comments = await client.getIssueCommentsWithViewerAuth('o', 'r', 42);

    expect('viewerDidAuthor' in comments[0]!).toBe(false);
  });

  it('propagates viewerDidAuthor: false onto the emitted Comment', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: graphqlResponse([{ databaseId: 300, viewerDidAuthor: false }]),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const comments = await client.getIssueCommentsWithViewerAuth('o', 'r', 42);

    expect(comments[0]!.viewerDidAuthor).toBe(false);
  });

  it('falls back to "" when author is null', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: graphqlResponse([{ databaseId: 400, author: null }]),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const comments = await client.getIssueCommentsWithViewerAuth('o', 'r', 42);

    expect(comments[0]!.author).toBe('');
  });

  it('leaves authorAssociation undefined when GraphQL returns null', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: graphqlResponse([{ databaseId: 500, authorAssociation: null }]),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const comments = await client.getIssueCommentsWithViewerAuth('o', 'r', 42);

    expect(comments[0]!.authorAssociation).toBeUndefined();
  });

  it('returns [] when the payload has no data node', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ data: null }),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const comments = await client.getIssueCommentsWithViewerAuth('o', 'r', 42);
    expect(comments).toEqual([]);
  });

  it('returns [] when the payload structure is missing issue', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ data: { repository: { issue: null } } }),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const comments = await client.getIssueCommentsWithViewerAuth('o', 'r', 42);
    expect(comments).toEqual([]);
  });

  it('throws GhAuthError(401) on HTTP 401', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)',
    });

    const client = new GhCliGitHubClient('/tmp');
    try {
      await client.getIssueCommentsWithViewerAuth('o', 'r', 42);
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
      await client.getIssueCommentsWithViewerAuth('o', 'r', 42);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GhAuthError);
      expect((err as GhAuthError).statusCode).toBe(403);
    }
  });

  it('surfaces stderr in generic Error on non-zero exit (non-auth)', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 500: internal server error boom',
    });

    const client = new GhCliGitHubClient('/tmp');
    await expect(client.getIssueCommentsWithViewerAuth('o', 'r', 42))
      .rejects.toThrow(/Failed to get issue comments for issue #42.*boom/);
    await expect(client.getIssueCommentsWithViewerAuth('o', 'r', 42))
      .rejects.not.toBeInstanceOf(GhAuthError);
  });
});
