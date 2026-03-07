/**
 * Unit tests for RepoCheckout — regression guard.
 *
 * Verifies that:
 * - ensureCheckout() with existing directory calls updateRepo() (fetch + reset)
 * - ensureCheckout() with non-existing directory calls cloneRepo()
 * - switchBranch() fetches and resets to remote HEAD
 * - getDefaultBranch() returns API result or falls back to 'develop'
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '../types.js';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared via vi.hoisted() so vi.mock() factories
// can reference them (vi.mock calls are hoisted above all other code).
// ---------------------------------------------------------------------------

const { mockExecFile, mockStat, mockMkdir, mockRm } = vi.hoisted(() => {
  const mockExecFile = vi.fn();
  const mockStat = vi.fn();
  const mockMkdir = vi.fn();
  const mockRm = vi.fn();
  return { mockExecFile, mockStat, mockMkdir, mockRm };
});

vi.mock('node:fs/promises', () => ({
  stat: mockStat,
  mkdir: mockMkdir,
  rm: mockRm,
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => {
    // Return the mock directly — tests control mockExecFile behavior
    if (fn === mockExecFile) return mockExecFile;
    return fn;
  },
}));

// ---------------------------------------------------------------------------
// Import SUT (after mocks are declared)
// ---------------------------------------------------------------------------

import { RepoCheckout } from '../repo-checkout.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger;

function enoentError(): NodeJS.ErrnoException {
  const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

/** Match an execFile call by command and first arg(s) */
type ExecFileCall = [string, string[], Record<string, unknown>?];

function findCall(
  command: string,
  argsPrefix: string[],
): ExecFileCall | undefined {
  return (mockExecFile.mock.calls as ExecFileCall[]).find(
    (call) =>
      call[0] === command &&
      argsPrefix.every((arg, i) => call[1][i] === arg),
  );
}

function findAllCalls(
  command: string,
  argsPrefix: string[],
): ExecFileCall[] {
  return (mockExecFile.mock.calls as ExecFileCall[]).filter(
    (call) =>
      call[0] === command &&
      argsPrefix.every((arg, i) => call[1][i] === arg),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RepoCheckout', () => {
  let checkout: RepoCheckout;

  beforeEach(() => {
    vi.clearAllMocks();
    checkout = new RepoCheckout('/workspace', mockLogger);

    // Default: execFile succeeds
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    mockMkdir.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // getCheckoutPath
  // -------------------------------------------------------------------------
  describe('getCheckoutPath()', () => {
    it('returns isolated path when no bootstrapped repo exists', async () => {
      mockStat.mockRejectedValue(enoentError());
      const path = await checkout.getCheckoutPath('worker-1', 'octocat', 'hello-world');
      expect(path).toBe('/workspace/worker-1/octocat/hello-world');
    });

    it('returns bootstrapped path when repo .git exists at {workspaceDir}/{repo}', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      const path = await checkout.getCheckoutPath('worker-1', 'octocat', 'hello-world');
      expect(path).toBe('/workspace/hello-world');
    });
  });

  // -------------------------------------------------------------------------
  // ensureCheckout — existing directory (update path)
  // -------------------------------------------------------------------------
  describe('ensureCheckout() with existing directory', () => {
    beforeEach(() => {
      // First stat: bootstrapped .git check → not found (fall back to isolated path)
      // Second stat: isolated checkout path → exists
      mockStat
        .mockRejectedValueOnce(enoentError())   // getCheckoutPath: no bootstrapped repo
        .mockResolvedValue({ isDirectory: () => true }); // ensureCheckout: dir exists
    });

    it('calls fetch origin', async () => {
      await checkout.ensureCheckout('worker-1', 'octocat', 'repo', 'develop');

      const call = findCall('git', ['fetch', 'origin']);
      expect(call).toBeDefined();
      expect(call![2]).toEqual({ cwd: '/workspace/worker-1/octocat/repo' });
    });

    it('calls reset --hard origin/<branch>', async () => {
      await checkout.ensureCheckout('worker-1', 'octocat', 'repo', 'develop');

      const call = findCall('git', ['reset', '--hard', 'origin/develop']);
      expect(call).toBeDefined();
      expect(call![2]).toEqual({ cwd: '/workspace/worker-1/octocat/repo' });
    });

    it('checks out the requested branch', async () => {
      await checkout.ensureCheckout('worker-1', 'octocat', 'repo', 'develop');

      const call = findCall('git', ['checkout', 'develop']);
      expect(call).toBeDefined();
    });

    it('creates tracking branch when local branch does not exist', async () => {
      // First checkout attempt fails (branch doesn't exist locally)
      mockExecFile.mockImplementation(
        async (cmd: string, args: string[]) => {
          if (cmd === 'git' && args[0] === 'checkout' && args[1] === 'develop' && args.length === 2) {
            throw new Error("error: pathspec 'develop' did not match any file(s) known to git");
          }
          return { stdout: '', stderr: '' };
        },
      );

      await checkout.ensureCheckout('worker-1', 'octocat', 'repo', 'develop');

      const call = findCall('git', ['checkout', '-b', 'develop', 'origin/develop']);
      expect(call).toBeDefined();
    });

    it('does not clone when directory exists', async () => {
      await checkout.ensureCheckout('worker-1', 'octocat', 'repo', 'develop');

      const cloneCall = findCall('git', ['clone']);
      expect(cloneCall).toBeUndefined();
    });

    it('returns the checkout path', async () => {
      const path = await checkout.ensureCheckout('worker-1', 'octocat', 'repo', 'develop');
      expect(path).toBe('/workspace/worker-1/octocat/repo');
    });

    it('runs fetch before reset (correct order)', async () => {
      const callOrder: string[] = [];
      mockExecFile.mockImplementation(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0]) {
          callOrder.push(args[0]);
        }
        return { stdout: '', stderr: '' };
      });

      await checkout.ensureCheckout('worker-1', 'octocat', 'repo', 'develop');

      const fetchIdx = callOrder.indexOf('fetch');
      const resetIdx = callOrder.indexOf('reset');
      expect(fetchIdx).toBeGreaterThanOrEqual(0);
      expect(resetIdx).toBeGreaterThan(fetchIdx);
    });
  });

  // -------------------------------------------------------------------------
  // ensureCheckout — non-existing directory (clone path)
  // -------------------------------------------------------------------------
  describe('ensureCheckout() with non-existing directory', () => {
    beforeEach(() => {
      // Both stat calls fail: no bootstrapped repo, no isolated checkout
      mockStat.mockRejectedValue(enoentError());
    });

    it('calls git clone with --branch and correct repo URL', async () => {
      await checkout.ensureCheckout('worker-1', 'octocat', 'repo', 'develop');

      const call = findCall('git', ['clone', '--branch', 'develop']);
      expect(call).toBeDefined();
      expect(call![1]).toContain('https://github.com/octocat/repo.git');
      expect(call![1]).toContain('/workspace/worker-1/octocat/repo');
    });

    it('creates parent directories before cloning', async () => {
      const callOrder: string[] = [];
      mockMkdir.mockImplementation(async () => {
        callOrder.push('mkdir');
      });
      mockExecFile.mockImplementation(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'clone') {
          callOrder.push('clone');
        }
        return { stdout: '', stderr: '' };
      });

      await checkout.ensureCheckout('worker-1', 'octocat', 'repo', 'develop');

      expect(callOrder.indexOf('mkdir')).toBeLessThan(callOrder.indexOf('clone'));
    });

    it('creates parent directory with recursive option', async () => {
      await checkout.ensureCheckout('worker-1', 'octocat', 'repo', 'develop');

      expect(mockMkdir).toHaveBeenCalledWith(
        '/workspace/worker-1/octocat',
        { recursive: true },
      );
    });

    it('does not call fetch or reset when cloning fresh', async () => {
      await checkout.ensureCheckout('worker-1', 'octocat', 'repo', 'develop');

      const fetchCalls = findAllCalls('git', ['fetch']);
      const resetCalls = findAllCalls('git', ['reset']);
      expect(fetchCalls).toHaveLength(0);
      expect(resetCalls).toHaveLength(0);
    });

    it('returns the checkout path', async () => {
      const path = await checkout.ensureCheckout('worker-1', 'octocat', 'repo', 'develop');
      expect(path).toBe('/workspace/worker-1/octocat/repo');
    });
  });

  // -------------------------------------------------------------------------
  // ensureCheckout — bootstrapped repo (container-per-worker mode)
  // -------------------------------------------------------------------------
  describe('ensureCheckout() with bootstrapped repo', () => {
    beforeEach(() => {
      // Bootstrapped .git exists → use /workspace/repo directly
      mockStat.mockResolvedValue({ isDirectory: () => true });
    });

    it('uses bootstrapped path instead of isolated path', async () => {
      const path = await checkout.ensureCheckout('worker-1', 'octocat', 'repo', 'develop');
      expect(path).toBe('/workspace/repo');
    });

    it('fetches and resets in bootstrapped checkout', async () => {
      await checkout.ensureCheckout('worker-1', 'octocat', 'repo', 'develop');

      const fetchCall = findCall('git', ['fetch', 'origin']);
      expect(fetchCall).toBeDefined();
      expect(fetchCall![2]).toEqual({ cwd: '/workspace/repo' });

      const resetCall = findCall('git', ['reset', '--hard', 'origin/develop']);
      expect(resetCall).toBeDefined();
      expect(resetCall![2]).toEqual({ cwd: '/workspace/repo' });
    });

    it('does not clone when bootstrapped repo exists', async () => {
      await checkout.ensureCheckout('worker-1', 'octocat', 'repo', 'develop');

      const cloneCall = findCall('git', ['clone']);
      expect(cloneCall).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // ensureCheckout — stat error other than ENOENT
  // -------------------------------------------------------------------------
  describe('ensureCheckout() with unexpected stat error', () => {
    it('re-throws non-ENOENT errors from stat', async () => {
      const permError = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      permError.code = 'EACCES';
      // First stat (bootstrapped .git) → not found (normal)
      // Second stat (isolated checkout) → permission error
      mockStat
        .mockRejectedValueOnce(enoentError())
        .mockRejectedValue(permError);

      await expect(
        checkout.ensureCheckout('worker-1', 'octocat', 'repo', 'develop'),
      ).rejects.toThrow('EACCES');
    });
  });

  // -------------------------------------------------------------------------
  // switchBranch
  // -------------------------------------------------------------------------
  describe('switchBranch()', () => {
    it('fetches from origin', async () => {
      await checkout.switchBranch('/workspace/worker-1/octocat/repo', 'feature-42');

      const call = findCall('git', ['fetch', 'origin']);
      expect(call).toBeDefined();
      expect(call![2]).toEqual({ cwd: '/workspace/worker-1/octocat/repo' });
    });

    it('checks out the requested branch', async () => {
      await checkout.switchBranch('/workspace/worker-1/octocat/repo', 'feature-42');

      const call = findCall('git', ['checkout', 'feature-42']);
      expect(call).toBeDefined();
    });

    it('resets to origin/<branch>', async () => {
      await checkout.switchBranch('/workspace/worker-1/octocat/repo', 'feature-42');

      const call = findCall('git', ['reset', '--hard', 'origin/feature-42']);
      expect(call).toBeDefined();
      expect(call![2]).toEqual({ cwd: '/workspace/worker-1/octocat/repo' });
    });

    it('creates tracking branch when local branch does not exist', async () => {
      mockExecFile.mockImplementation(
        async (cmd: string, args: string[]) => {
          if (cmd === 'git' && args[0] === 'checkout' && args[1] === 'feature-42' && args.length === 2) {
            throw new Error("error: pathspec 'feature-42' did not match");
          }
          return { stdout: '', stderr: '' };
        },
      );

      await checkout.switchBranch('/workspace/worker-1/octocat/repo', 'feature-42');

      const call = findCall('git', ['checkout', '-b', 'feature-42', 'origin/feature-42']);
      expect(call).toBeDefined();
    });

    it('still resets to remote HEAD after creating tracking branch', async () => {
      mockExecFile.mockImplementation(
        async (cmd: string, args: string[]) => {
          if (cmd === 'git' && args[0] === 'checkout' && args[1] === 'feature-42' && args.length === 2) {
            throw new Error("error: pathspec 'feature-42' did not match");
          }
          return { stdout: '', stderr: '' };
        },
      );

      await checkout.switchBranch('/workspace/worker-1/octocat/repo', 'feature-42');

      const call = findCall('git', ['reset', '--hard', 'origin/feature-42']);
      expect(call).toBeDefined();
    });

    it('runs fetch → checkout → reset in order', async () => {
      const callOrder: string[] = [];
      mockExecFile.mockImplementation(async (cmd: string, args: string[]) => {
        if (cmd === 'git') {
          callOrder.push(`${args[0]}(${args.slice(1).join(',')})`);
        }
        return { stdout: '', stderr: '' };
      });

      await checkout.switchBranch('/workspace/worker-1/octocat/repo', 'my-branch');

      const fetchIdx = callOrder.findIndex((c) => c.startsWith('fetch'));
      const checkoutIdx = callOrder.findIndex((c) => c.startsWith('checkout'));
      const resetIdx = callOrder.findIndex((c) => c.startsWith('reset'));

      expect(fetchIdx).toBeGreaterThanOrEqual(0);
      expect(checkoutIdx).toBeGreaterThan(fetchIdx);
      expect(resetIdx).toBeGreaterThan(checkoutIdx);
    });
  });

  // -------------------------------------------------------------------------
  // getDefaultBranch
  // -------------------------------------------------------------------------
  describe('getDefaultBranch()', () => {
    it('returns branch name from gh repo view', async () => {
      mockExecFile.mockResolvedValue({ stdout: 'main\n', stderr: '' });

      const result = await checkout.getDefaultBranch('octocat', 'hello-world');

      expect(result).toBe('main');
      const call = findCall('gh', ['repo', 'view']);
      expect(call).toBeDefined();
      expect(call![1]).toContain('octocat/hello-world');
    });

    it('passes correct gh arguments', async () => {
      mockExecFile.mockResolvedValue({ stdout: 'develop\n', stderr: '' });

      await checkout.getDefaultBranch('octocat', 'repo');

      const call = findCall('gh', ['repo', 'view']);
      expect(call![1]).toEqual([
        'repo', 'view', 'octocat/repo',
        '--json', 'defaultBranchRef',
        '-q', '.defaultBranchRef.name',
      ]);
    });

    it('falls back to develop when gh command fails', async () => {
      mockExecFile.mockRejectedValue(new Error('gh: command not found'));

      const result = await checkout.getDefaultBranch('octocat', 'repo');

      expect(result).toBe('develop');
    });

    it('falls back to develop when gh returns empty string', async () => {
      mockExecFile.mockResolvedValue({ stdout: '\n', stderr: '' });

      const result = await checkout.getDefaultBranch('octocat', 'repo');

      expect(result).toBe('develop');
    });

    it('falls back to develop when gh returns only whitespace', async () => {
      mockExecFile.mockResolvedValue({ stdout: '  \n  ', stderr: '' });

      const result = await checkout.getDefaultBranch('octocat', 'repo');

      expect(result).toBe('develop');
    });

    it('logs resolved branch on success', async () => {
      mockExecFile.mockResolvedValue({ stdout: 'main\n', stderr: '' });

      await checkout.getDefaultBranch('octocat', 'repo');

      expect(mockLogger.info).toHaveBeenCalledWith(
        { owner: 'octocat', repo: 'repo', branch: 'main' },
        'Resolved default branch',
      );
    });

    it('logs warning on failure', async () => {
      const error = new Error('gh: command not found');
      mockExecFile.mockRejectedValue(error);

      await checkout.getDefaultBranch('octocat', 'repo');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { err: error, owner: 'octocat', repo: 'repo' },
        'Failed to resolve default branch, falling back to develop',
      );
    });
  });

  // -------------------------------------------------------------------------
  // cleanup
  // -------------------------------------------------------------------------
  describe('cleanup()', () => {
    it('removes directory recursively with force', async () => {
      await checkout.cleanup('/workspace/worker-1/octocat/repo');

      expect(mockRm).toHaveBeenCalledWith('/workspace/worker-1/octocat/repo', {
        recursive: true,
        force: true,
      });
    });
  });
});
