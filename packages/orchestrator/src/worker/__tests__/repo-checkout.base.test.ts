/**
 * Unit tests for `RepoCheckout.fetchBase` and `RepoCheckout.resetToBranchTip`.
 *
 * These are the git primitives that back the pre-phase base-merge hook (#864).
 * `switchBranch` regression coverage still lives in repo-checkout.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '../types.js';

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => {
    if (fn === mockExecFile) return mockExecFile;
    return fn;
  },
}));

import { RepoCheckout } from '../repo-checkout.js';

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger;

describe('RepoCheckout base-merge primitives', () => {
  let checkout: RepoCheckout;

  beforeEach(() => {
    vi.clearAllMocks();
    checkout = new RepoCheckout('/workspace', mockLogger);
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
  });

  describe('fetchBase()', () => {
    it('invokes `git fetch origin <baseBranch>` in the checkout cwd', async () => {
      await checkout.fetchBase('/w', 'main');

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['fetch', 'origin', 'main'],
        { cwd: '/w' },
      );
    });

    it('accepts the un-prefixed branch name (no `origin/` prefix)', async () => {
      await checkout.fetchBase('/w', 'develop');

      const call = mockExecFile.mock.calls.find(
        (c) => c[0] === 'git' && c[1][0] === 'fetch',
      );
      expect(call).toBeDefined();
      expect(call![1]).toEqual(['fetch', 'origin', 'develop']);
    });
  });

  describe('resetToBranchTip()', () => {
    it('invokes `git reset --hard origin/<branch>` in the checkout cwd', async () => {
      await checkout.resetToBranchTip('/w', '864-found-during-cockpit-v1');

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['reset', '--hard', 'origin/864-found-during-cockpit-v1'],
        { cwd: '/w' },
      );
    });
  });
});
