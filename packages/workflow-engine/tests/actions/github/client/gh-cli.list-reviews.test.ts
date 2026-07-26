import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/actions/cli-utils.js', () => ({
  executeCommand: vi.fn(),
  parseJSONSafe: vi.fn((input: string) => {
    try { return JSON.parse(input); } catch { return null; }
  }),
}));

import { executeCommand } from '../../../../src/actions/cli-utils.js';
import { GhCliGitHubClient } from '../../../../src/actions/github/client/gh-cli.js';

const mockExecuteCommand = vi.mocked(executeCommand);

describe('GhCliGitHubClient.listReviews (#1047)', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  it('returns reviews with authorAssociation populated when the response includes it', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([
        {
          id: 111,
          user: { login: 'alice' },
          body: 'looks good',
          state: 'APPROVED',
          submitted_at: '2026-07-26T10:00:00Z',
          author_association: 'MEMBER',
        },
      ]),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const reviews = await client.listReviews('o', 'r', 42);

    expect(reviews).toEqual([
      {
        id: 111,
        user: { login: 'alice' },
        body: 'looks good',
        state: 'APPROVED',
        submittedAt: '2026-07-26T10:00:00Z',
        authorAssociation: 'MEMBER',
      },
    ]);
  });

  it('#1047 Finding 7: skips reviews with unknown states instead of throwing for the whole batch', async () => {
    // A future or unexpected state must NOT nuke the whole call — that would
    // silently disable the #1047 body-consumption gate. Verify the known
    // reviews still come through.
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([
        {
          id: 100,
          user: { login: 'a' },
          body: 'known',
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-07-26T10:00:00Z',
          author_association: 'OWNER',
        },
        {
          id: 200,
          user: { login: 'b' },
          body: 'ignored — unknown state',
          state: 'SOMETHING_NEW',
          submitted_at: '2026-07-26T11:00:00Z',
          author_association: 'MEMBER',
        },
        {
          id: 300,
          user: { login: 'c' },
          body: 'also known',
          state: 'COMMENTED',
          submitted_at: '2026-07-26T12:00:00Z',
          author_association: 'MEMBER',
        },
      ]),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const reviews = await client.listReviews('o', 'r', 42);

    expect(reviews).toHaveLength(2);
    expect(reviews.map((r) => r.id)).toEqual([100, 300]);
    expect(reviews.map((r) => r.state)).toEqual(['CHANGES_REQUESTED', 'COMMENTED']);
  });

  it('handles missing author_association gracefully (field left undefined)', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([
        {
          id: 1,
          user: { login: 'anon' },
          body: 'hi',
          state: 'COMMENTED',
          submitted_at: '2026-07-26T10:00:00Z',
        },
      ]),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const reviews = await client.listReviews('o', 'r', 42);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.authorAssociation).toBeUndefined();
  });

  it('throws only on the outer gh command failure', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'gh: not found',
    });

    const client = new GhCliGitHubClient('/tmp');
    await expect(client.listReviews('o', 'r', 42)).rejects.toThrow(/Failed to list reviews/);
  });

  it('returns [] on empty response', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: '[]',
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const reviews = await client.listReviews('o', 'r', 42);
    expect(reviews).toEqual([]);
  });
});
