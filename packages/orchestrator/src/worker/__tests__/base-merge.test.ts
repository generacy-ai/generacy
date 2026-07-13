/**
 * Unit tests for the base-merge runner (specs/864-found-during-cockpit-v1).
 *
 * Tests cover `performBaseMerge` git-command sequence and result shape, plus
 * `resolveBaseBranch` PR-present and fallback paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '../types.js';

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => {
    if (fn === mockExecFile) return mockExecFile;
    return fn;
  },
}));

import { performBaseMerge, resolveBaseBranch } from '../base-merge.js';

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger;

interface RecordedCall {
  cmd: string;
  args: string[];
  opts?: Record<string, unknown>;
}

function recordedCalls(): RecordedCall[] {
  return mockExecFile.mock.calls.map((c) => ({
    cmd: c[0] as string,
    args: c[1] as string[],
    opts: c[2] as Record<string, unknown> | undefined,
  }));
}

function makeExecFileError(stderr = '', message = 'command failed'): Error {
  const err = new Error(message) as Error & { stderr?: string; stdout?: string; code?: number };
  err.stderr = stderr;
  err.stdout = '';
  err.code = 1;
  return err;
}

describe('performBaseMerge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
  });

  it('validates that baseRef starts with origin/ prefix', async () => {
    await expect(
      performBaseMerge('/w', '864-branch', 'main', { commit: true }, mockLogger),
    ).rejects.toThrow(/must start with 'origin\//);
  });

  it('clean merge with commit=true: runs reset+clean, fetch, merge, rev-parse; returns ok+mergeSha', async () => {
    mockExecFile.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: 'abc123def\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await performBaseMerge(
      '/w',
      '864-branch',
      'origin/main',
      { commit: true },
      mockLogger,
    );

    expect(result).toEqual({ ok: true, baseRef: 'origin/main', mergeSha: 'abc123def' });

    const calls = recordedCalls();
    // 1. reset --hard origin/<branch>
    expect(calls[0]).toMatchObject({
      cmd: 'git',
      args: ['reset', '--hard', 'origin/864-branch'],
      opts: { cwd: '/w' },
    });
    // 2. clean -fd
    expect(calls[1]).toMatchObject({ cmd: 'git', args: ['clean', '-fd'] });
    // 3. fetch origin <base-branch>
    expect(calls[2]).toMatchObject({ cmd: 'git', args: ['fetch', 'origin', 'main'] });
    // 4. merge --no-ff origin/main (no --no-commit)
    expect(calls[3]).toMatchObject({
      cmd: 'git',
      args: ['merge', '--no-ff', 'origin/main'],
    });
    // 5. rev-parse HEAD → mergeSha
    expect(calls[4]).toMatchObject({ cmd: 'git', args: ['rev-parse', 'HEAD'] });
  });

  it('clean merge with commit=false: merge command includes --no-commit; no rev-parse; no mergeSha', async () => {
    const result = await performBaseMerge(
      '/w',
      '864-branch',
      'origin/main',
      { commit: false },
      mockLogger,
    );

    expect(result).toEqual({ ok: true, baseRef: 'origin/main' });
    expect((result as { mergeSha?: string }).mergeSha).toBeUndefined();

    const calls = recordedCalls();
    const mergeCall = calls.find((c) => c.args[0] === 'merge' && c.args[1] === '--no-ff');
    expect(mergeCall).toBeDefined();
    expect(mergeCall!.args).toEqual(['merge', '--no-ff', '--no-commit', 'origin/main']);

    const revParseCall = calls.find((c) => c.args[0] === 'rev-parse');
    expect(revParseCall).toBeUndefined();
  });

  it('conflict path: parses diff --name-only --diff-filter=U output, aborts merge, returns ok:false + paths', async () => {
    mockExecFile.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'merge' && args.includes('--no-ff')) {
        throw makeExecFileError('CONFLICT (add/add): Merge conflict in package.json');
      }
      if (cmd === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) {
        return { stdout: 'CLAUDE.md\npackage.json\npackage-lock.json\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await performBaseMerge(
      '/w',
      '864-branch',
      'origin/main',
      { commit: true },
      mockLogger,
    );

    expect(result).toEqual({
      ok: false,
      baseRef: 'origin/main',
      conflictedPaths: ['CLAUDE.md', 'package.json', 'package-lock.json'],
    });

    const calls = recordedCalls();
    // git diff --name-only --diff-filter=U was called
    expect(calls.some((c) => c.args[0] === 'diff' && c.args.includes('--diff-filter=U'))).toBe(true);
    // git merge --abort was called
    expect(calls.some((c) => c.args[0] === 'merge' && c.args[1] === '--abort')).toBe(true);
  });

  it('merge failure with empty conflict list but conflict-like stderr: returns ok:false with placeholder', async () => {
    mockExecFile.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'merge' && args.includes('--no-ff')) {
        throw makeExecFileError('CONFLICT: merge failed');
      }
      if (cmd === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await performBaseMerge(
      '/w',
      '864-branch',
      'origin/main',
      { commit: true },
      mockLogger,
    );

    expect(result.ok).toBe(false);
    expect((result as { conflictedPaths: string[] }).conflictedPaths).toEqual([
      '<unknown: merge failed without conflict list>',
    ]);
  });

  it('non-conflict merge failure (network/bad-ref) throws instead of returning ok:false', async () => {
    mockExecFile.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'merge' && args.includes('--no-ff')) {
        throw makeExecFileError('fatal: refusing to merge unrelated histories', 'fatal error');
      }
      if (cmd === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(
      performBaseMerge('/w', '864-branch', 'origin/main', { commit: true }, mockLogger),
    ).rejects.toThrow(/fatal error/);
  });

  it('idempotent: consecutive invocations begin with reset --hard so no state leaks between runs', async () => {
    mockExecFile.mockResolvedValue({ stdout: 'sha1\n', stderr: '' });

    await performBaseMerge('/w', 'br', 'origin/main', { commit: true }, mockLogger);
    const firstRunCallCount = mockExecFile.mock.calls.length;

    await performBaseMerge('/w', 'br', 'origin/main', { commit: true }, mockLogger);

    // Second run began with reset+clean (same as first)
    const secondRunStart = mockExecFile.mock.calls[firstRunCallCount];
    expect(secondRunStart[0]).toBe('git');
    expect(secondRunStart[1]).toEqual(['reset', '--hard', 'origin/br']);
  });
});

describe('resolveBaseBranch', () => {
  const mockPrManager = (prNumber?: number) => ({
    getPrNumber: vi.fn().mockReturnValue(prNumber),
  }) as unknown as import('../pr-manager.js').PrManager;

  it('returns origin/<PR-base> when a PR exists', async () => {
    const mockGithub = {
      getPullRequest: vi.fn().mockResolvedValue({ base: { ref: 'main' } }),
      getDefaultBranch: vi.fn(),
    } as unknown as import('@generacy-ai/workflow-engine').GitHubClient;

    const result = await resolveBaseBranch(
      mockGithub,
      mockPrManager(42),
      '/w',
      'octocat',
      'sniplink',
      mockLogger,
    );

    expect(result).toBe('origin/main');
    expect(mockGithub.getPullRequest).toHaveBeenCalledWith('octocat', 'sniplink', 42);
  });

  it('falls back to origin/<default-branch> when no PR exists yet', async () => {
    const mockGithub = {
      getPullRequest: vi.fn(),
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
    } as unknown as import('@generacy-ai/workflow-engine').GitHubClient;

    const result = await resolveBaseBranch(
      mockGithub,
      mockPrManager(undefined),
      '/w',
      'octocat',
      'sniplink',
      mockLogger,
    );

    expect(result).toBe('origin/develop');
    expect(mockGithub.getPullRequest).not.toHaveBeenCalled();
  });
});
