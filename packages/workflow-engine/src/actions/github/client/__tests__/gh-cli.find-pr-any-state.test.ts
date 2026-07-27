/**
 * Unit tests for GhCliGitHubClient.findPRForBranchAnyState (#1051 FR-002).
 *
 * Covers the contract in
 * specs/1051-problem-after-speckit-pr/contracts/find-pr-for-branch-any-state.md:
 *   - empty list → null
 *   - OPEN / MERGED / CLOSED variants → object with matching lowercase `state`
 *   - non-zero exit → null
 *   - static argv assertion that `--state all` is present
 *
 * Also asserts invariant I-2 (Q2 clarification): `findPRForBranch` must NOT
 * pass `--state all`. If this negative assertion ever regresses, it would
 * silently widen five existing call sites to include closed/merged PRs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../cli-utils.js', () => ({
  executeCommand: vi.fn(),
  parseJSONSafe: vi.fn((input: string) => {
    try { return JSON.parse(input); } catch { return null; }
  }),
}));

import { executeCommand } from '../../../cli-utils.js';
import { GhCliGitHubClient } from '../gh-cli.js';

const mockExecuteCommand = vi.mocked(executeCommand);

describe('GhCliGitHubClient.findPRForBranchAnyState', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  function prJson(overrides: Partial<{
    number: number;
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    isDraft: boolean;
    headRefName: string;
    baseRefName: string;
    title: string;
    body: string;
    labels: Array<{ name: string; color: string }>;
    createdAt: string;
    updatedAt: string;
  }> = {}): string {
    const pr = {
      number: overrides.number ?? 42,
      title: overrides.title ?? 'Test PR',
      body: overrides.body ?? 'body',
      state: overrides.state ?? 'OPEN',
      isDraft: overrides.isDraft ?? false,
      headRefName: overrides.headRefName ?? 'feature',
      baseRefName: overrides.baseRefName ?? 'develop',
      labels: overrides.labels ?? [],
      createdAt: overrides.createdAt ?? '2026-07-01T00:00:00Z',
      updatedAt: overrides.updatedAt ?? '2026-07-01T00:00:00Z',
    };
    return JSON.stringify([pr]);
  }

  it('returns null when gh pr list returns empty array', async () => {
    mockExecuteCommand.mockResolvedValue({ exitCode: 0, stdout: '[]', stderr: '' });
    const client = new GhCliGitHubClient('/tmp');
    const result = await client.findPRForBranchAnyState('o', 'r', 'feature');
    expect(result).toBeNull();
  });

  it('returns object with state="open" when PR is OPEN', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: prJson({ state: 'OPEN', number: 100 }),
      stderr: '',
    });
    const client = new GhCliGitHubClient('/tmp');
    const result = await client.findPRForBranchAnyState('o', 'r', 'feature');
    expect(result).not.toBeNull();
    expect(result!.state).toBe('open');
    expect(result!.number).toBe(100);
  });

  it('returns object with state="merged" when PR is MERGED', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: prJson({ state: 'MERGED', number: 200 }),
      stderr: '',
    });
    const client = new GhCliGitHubClient('/tmp');
    const result = await client.findPRForBranchAnyState('o', 'r', 'feature');
    expect(result).not.toBeNull();
    expect(result!.state).toBe('merged');
    expect(result!.number).toBe(200);
  });

  it('returns object with state="closed" when PR is CLOSED', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: prJson({ state: 'CLOSED', number: 300 }),
      stderr: '',
    });
    const client = new GhCliGitHubClient('/tmp');
    const result = await client.findPRForBranchAnyState('o', 'r', 'feature');
    expect(result).not.toBeNull();
    expect(result!.state).toBe('closed');
    expect(result!.number).toBe(300);
  });

  it('returns null when gh pr list exits non-zero', async () => {
    mockExecuteCommand.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'oops' });
    const client = new GhCliGitHubClient('/tmp');
    const result = await client.findPRForBranchAnyState('o', 'r', 'feature');
    expect(result).toBeNull();
  });

  it('passes --state all in the argv to executeGh', async () => {
    mockExecuteCommand.mockResolvedValue({ exitCode: 0, stdout: '[]', stderr: '' });
    const client = new GhCliGitHubClient('/tmp');
    await client.findPRForBranchAnyState('o', 'r', 'feature');

    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockExecuteCommand.mock.calls[0]!;
    expect(cmd).toBe('gh');
    expect(args).toEqual(expect.arrayContaining(['--state', 'all']));
    // Verify --state comes before all
    const stateIdx = (args as string[]).indexOf('--state');
    expect(stateIdx).toBeGreaterThanOrEqual(0);
    expect((args as string[])[stateIdx + 1]).toBe('all');
  });

  // Regression: invariant I-2 (Q2 clarification, spec.md).
  // findPRForBranch MUST NOT pass --state all. Five call sites depend on the
  // open-only default; widening would create foot-guns.
  it('findPRForBranch does NOT pass --state all (invariant I-2 regression guard)', async () => {
    mockExecuteCommand.mockResolvedValue({ exitCode: 0, stdout: '[]', stderr: '' });
    const client = new GhCliGitHubClient('/tmp');
    await client.findPRForBranch('o', 'r', 'feature');

    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
    const [, args] = mockExecuteCommand.mock.calls[0]!;
    expect(args).not.toContain('--state');
  });
});
