/**
 * Unit tests for GhCliGitHubClient.createReview (#1125 T007).
 *
 * Covers contracts/github-client-methods.md §createReview:
 *   - REST POST /repos/{owner}/{repo}/pulls/{n}/reviews
 *   - JSON body carries event / body / comments[] (written to a temp --input file)
 *   - returns the parsed Review
 *   - non-zero exit throws
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../../cli-utils.js', () => ({
  executeCommand: vi.fn(),
  parseJSONSafe: vi.fn((input: string) => {
    try { return JSON.parse(input); } catch { return null; }
  }),
}));

import { executeCommand } from '../../../cli-utils.js';
import { GhCliGitHubClient } from '../gh-cli.js';

const mockExecuteCommand = vi.mocked(executeCommand);

const SUCCESS_STDOUT = JSON.stringify({
  id: 555,
  user: { login: 'generacy-bot' },
  body: 'Round 1',
  state: 'COMMENTED',
  submitted_at: '2026-08-19T10:00:00Z',
});

describe('GhCliGitHubClient.createReview', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  it('posts to the correct REST path with the JSON body on stdin (temp --input file)', async () => {
    let capturedBody: unknown;
    mockExecuteCommand.mockImplementation(async (_cmd, args) => {
      // Capture the temp file content that carries the JSON body.
      const idx = args.indexOf('--input');
      const inputPath = args[idx + 1]!;
      capturedBody = JSON.parse(readFileSync(inputPath, 'utf8'));
      return { exitCode: 0, stdout: SUCCESS_STDOUT, stderr: '' };
    });

    const client = new GhCliGitHubClient('/tmp');
    const review = await client.createReview('o', 'r', 42, {
      event: 'COMMENT',
      body: 'Round 1',
      comments: [{ path: 'src/x.ts', line: 10, body: 'nit' }],
    });

    const args = mockExecuteCommand.mock.calls[0]![1];
    expect(args).toContain('api');
    expect(args).toContain('--method');
    expect(args).toContain('POST');
    expect(args).toContain('/repos/o/r/pulls/42/reviews');

    expect(capturedBody).toEqual({
      event: 'COMMENT',
      body: 'Round 1',
      comments: [{ path: 'src/x.ts', line: 10, side: 'RIGHT', body: 'nit' }],
    });

    expect(review).toEqual({
      id: 555,
      user: { login: 'generacy-bot' },
      body: 'Round 1',
      state: 'COMMENTED',
      submittedAt: '2026-08-19T10:00:00Z',
    });
  });

  it('defaults each comment side to RIGHT and tolerates no comments', async () => {
    let capturedBody: { comments: unknown[] } | undefined;
    mockExecuteCommand.mockImplementation(async (_cmd, args) => {
      const idx = args.indexOf('--input');
      capturedBody = JSON.parse(readFileSync(args[idx + 1]!, 'utf8'));
      return { exitCode: 0, stdout: SUCCESS_STDOUT, stderr: '' };
    });

    const client = new GhCliGitHubClient('/tmp');
    await client.createReview('o', 'r', 42, { event: 'COMMENT', body: 'body only' });

    expect(capturedBody!.comments).toEqual([]);
  });

  it('throws with stderr on non-zero exit', async () => {
    mockExecuteCommand.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'Validation Failed' });
    const client = new GhCliGitHubClient('/tmp');
    await expect(
      client.createReview('o', 'r', 42, { event: 'COMMENT', body: 'x' }),
    ).rejects.toThrow(/Failed to create review.*Validation Failed/);
  });
});
