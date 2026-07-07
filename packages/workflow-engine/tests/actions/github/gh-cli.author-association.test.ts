import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/actions/cli-utils.js', () => ({
  executeCommand: vi.fn(),
  parseJSONSafe: vi.fn((input: string) => {
    try { return JSON.parse(input); } catch { return null; }
  }),
}));

import { executeCommand } from '../../../src/actions/cli-utils.js';
import { GhCliGitHubClient } from '../../../src/actions/github/client/gh-cli.js';

const mockExecuteCommand = vi.mocked(executeCommand);

describe('GhCliGitHubClient — author_association projection', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  describe('getIssueComments', () => {
    it('populates authorAssociation from REST response', async () => {
      mockExecuteCommand.mockResolvedValue({
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify([
          {
            id: 1,
            body: 'first',
            user: { login: 'alice' },
            created_at: '2026-07-07T00:00:00Z',
            updated_at: '2026-07-07T00:00:00Z',
            author_association: 'OWNER',
          },
          {
            id: 2,
            body: 'second',
            user: { login: 'bob' },
            created_at: '2026-07-07T00:00:01Z',
            updated_at: '2026-07-07T00:00:01Z',
            author_association: 'NONE',
          },
        ]),
      });

      const client = new GhCliGitHubClient('/tmp');
      const comments = await client.getIssueComments('o', 'r', 1);

      expect(comments).toHaveLength(2);
      expect(comments[0]!.authorAssociation).toBe('OWNER');
      expect(comments[1]!.authorAssociation).toBe('NONE');
    });

    it('leaves authorAssociation undefined when field is missing from response', async () => {
      mockExecuteCommand.mockResolvedValue({
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify([
          {
            id: 1,
            body: 'no association',
            user: { login: 'alice' },
            created_at: '2026-07-07T00:00:00Z',
            updated_at: '2026-07-07T00:00:00Z',
          },
        ]),
      });

      const client = new GhCliGitHubClient('/tmp');
      const comments = await client.getIssueComments('o', 'r', 1);

      expect(comments).toHaveLength(1);
      expect(comments[0]!.authorAssociation).toBeUndefined();
    });
  });

  describe('getPRComments', () => {
    it('populates authorAssociation from jq-projected line-per-object stdout', async () => {
      const lines = [
        JSON.stringify({
          id: 10,
          body: 'nit',
          author: 'alice',
          author_association: 'MEMBER',
          path: 'src/a.ts',
          line: 1,
          in_reply_to_id: null,
          created_at: '2026-07-07T00:00:00Z',
          updated_at: '2026-07-07T00:00:00Z',
        }),
        JSON.stringify({
          id: 11,
          body: 'drive-by',
          author: 'eve',
          author_association: 'NONE',
          path: 'src/b.ts',
          line: 5,
          in_reply_to_id: null,
          created_at: '2026-07-07T00:00:01Z',
          updated_at: '2026-07-07T00:00:01Z',
        }),
      ].join('\n');

      mockExecuteCommand.mockResolvedValue({
        exitCode: 0,
        stderr: '',
        stdout: lines,
      });

      const client = new GhCliGitHubClient('/tmp');
      const comments = await client.getPRComments('o', 'r', 42);

      expect(comments).toHaveLength(2);
      expect(comments[0]!.authorAssociation).toBe('MEMBER');
      expect(comments[1]!.authorAssociation).toBe('NONE');
    });

    it('leaves authorAssociation undefined when field is absent from a line', async () => {
      const line = JSON.stringify({
        id: 12,
        body: 'no assoc',
        author: 'alice',
        path: 'x.ts',
        line: 1,
        in_reply_to_id: null,
        created_at: '2026-07-07T00:00:00Z',
        updated_at: '2026-07-07T00:00:00Z',
      });

      mockExecuteCommand.mockResolvedValue({
        exitCode: 0,
        stderr: '',
        stdout: line,
      });

      const client = new GhCliGitHubClient('/tmp');
      const comments = await client.getPRComments('o', 'r', 1);
      expect(comments).toHaveLength(1);
      expect(comments[0]!.authorAssociation).toBeUndefined();
    });

    it('includes author_association in the jq selector arg', async () => {
      mockExecuteCommand.mockResolvedValue({
        exitCode: 0,
        stderr: '',
        stdout: '',
      });

      const client = new GhCliGitHubClient('/tmp');
      await client.getPRComments('o', 'r', 1);

      expect(mockExecuteCommand).toHaveBeenCalledOnce();
      const jqArg = mockExecuteCommand.mock.calls[0]![1].find((a) => a.includes('author_association'));
      expect(jqArg).toBeDefined();
    });
  });
});
