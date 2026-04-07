/**
 * Unit tests for createFeature() branch sync behavior.
 *
 * Verifies that:
 * - New branches are always based on the latest remote default branch
 * - Epic parent branches use reset --hard instead of pull
 * - getDefaultBranch() resolves from symbolic-ref with fallback
 * - Resume path (feature dir exists) skips default-branch sync
 * - base_commit SHA is returned in output
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SimpleGit } from 'simple-git';

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.mock factories are hoisted above all other code, so
// any variables they reference must also be hoisted via vi.hoisted().
// ---------------------------------------------------------------------------

const { mockFs, mockSimpleGit } = vi.hoisted(() => {
  const mockFs = {
    exists: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    readDir: vi.fn(),
    findRepoRoot: vi.fn(),
    resolveSpecsPath: vi.fn(),
  };

  // Mutable ref so tests can swap the mock git instance
  const mockSimpleGit = { current: null as unknown };

  return { mockFs, mockSimpleGit };
});

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => mockSimpleGit.current),
}));

vi.mock('../fs.js', () => mockFs);

// ---------------------------------------------------------------------------
// Import SUT (after mocks are declared — vi.mock is hoisted anyway)
// ---------------------------------------------------------------------------

import { createFeature, getDefaultBranch } from '../feature.js';

// ---------------------------------------------------------------------------
// Mock git factory & call-order tracking
// ---------------------------------------------------------------------------

/** Call log — records every git method invocation in order */
let callLog: string[] = [];

function createMockGit(): SimpleGit {
  const git = {
    fetch: vi.fn().mockImplementation(async () => {
      callLog.push('fetch');
    }),
    checkout: vi.fn().mockImplementation(async (...args: unknown[]) => {
      if (Array.isArray(args[0])) {
        callLog.push(`checkout(${JSON.stringify(args[0])})`);
      } else {
        callLog.push(`checkout(${args[0]})`);
      }
    }),
    checkoutLocalBranch: vi.fn().mockImplementation(async (name: string) => {
      callLog.push(`checkoutLocalBranch(${name})`);
    }),
    reset: vi.fn().mockImplementation(async (args: string[]) => {
      callLog.push(`reset(${JSON.stringify(args)})`);
    }),
    branchLocal: vi.fn().mockResolvedValue({ all: [], current: 'develop' }),
    branch: vi.fn().mockResolvedValue({ all: [] }),
    pull: vi.fn().mockResolvedValue(undefined),
    raw: vi.fn().mockResolvedValue('refs/remotes/origin/develop'),
    revparse: vi.fn().mockImplementation(async (args: string[]) => {
      // Distinguish between SHA lookup and branch name lookup
      if (Array.isArray(args) && args.includes('--abbrev-ref')) {
        return '042-test-feature'; // default: branch verification succeeds
      }
      return 'abc123def456'; // default: commit SHA for base_commit
    }),
  } as unknown as SimpleGit;
  return git;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set default mock filesystem behaviors */
function resetFsMocks() {
  mockFs.exists.mockResolvedValue(false);
  mockFs.mkdir.mockResolvedValue(undefined);
  mockFs.writeFile.mockResolvedValue(undefined);
  mockFs.readFile.mockResolvedValue('{}');
  mockFs.readDir.mockResolvedValue([]);
  mockFs.findRepoRoot.mockResolvedValue('/repo');
  mockFs.resolveSpecsPath.mockResolvedValue('/repo/specs');
}

/** Configure mockFs.exists to return true only for specific paths */
function existsFor(paths: Record<string, boolean>) {
  mockFs.exists.mockImplementation(async (p: string) => {
    for (const [key, val] of Object.entries(paths)) {
      if (p.endsWith(key) || p === key) return val;
    }
    return false;
  });
}

// Convenience accessor for the current mock git instance
function git(): SimpleGit {
  return mockSimpleGit.current as SimpleGit;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createFeature()', () => {
  beforeEach(() => {
    callLog = [];

    // Reset filesystem mocks to defaults
    resetFsMocks();

    // Create a fresh mock git instance
    mockSimpleGit.current = createMockGit();

    // Default filesystem: repo with .git, no existing feature dir
    existsFor({
      '.git': true,          // isGitRepo → true
      'config.yaml': false, // no custom branch config
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test: new branch syncs to latest default branch
  // -------------------------------------------------------------------------
  describe('new branch creation', () => {
    it('syncs to latest default branch before creating feature branch', async () => {
      const result = await createFeature({
        description: 'test feature',
        number: 42,
        cwd: '/repo',
      });

      expect(result.success).toBe(true);
      expect(result.git_branch_created).toBe(true);

      // Assert checkout(defaultBranch) was called
      expect(git().checkout).toHaveBeenCalledWith('develop');

      // Assert reset --hard origin/develop was called
      expect(git().reset).toHaveBeenCalledWith(['--hard', 'origin/develop']);

      // Assert checkoutLocalBranch was called with the generated branch name
      expect(git().checkoutLocalBranch).toHaveBeenCalled();
    });

    it('calls fetch → checkout(default) → reset → checkoutLocalBranch in order', async () => {
      await createFeature({
        description: 'test feature',
        number: 42,
        cwd: '/repo',
      });

      // Extract the relevant operations from the call log
      const syncOps = callLog.filter(
        (op) =>
          op.startsWith('fetch') ||
          op === 'checkout(develop)' ||
          op.startsWith('reset') ||
          op.startsWith('checkoutLocalBranch'),
      );

      const fetchIdx = syncOps.indexOf('fetch');
      const checkoutIdx = syncOps.indexOf('checkout(develop)');
      const resetIdx = syncOps.findIndex((op) => op.includes('--hard'));
      const createBranchIdx = syncOps.findIndex((op) =>
        op.startsWith('checkoutLocalBranch'),
      );

      expect(fetchIdx).toBeGreaterThanOrEqual(0);
      expect(checkoutIdx).toBeGreaterThan(fetchIdx);
      expect(resetIdx).toBeGreaterThan(checkoutIdx);
      expect(createBranchIdx).toBeGreaterThan(resetIdx);
    });

    it('uses the resolved default branch name, not hardcoded develop', async () => {
      (git().raw as ReturnType<typeof vi.fn>).mockResolvedValue(
        'refs/remotes/origin/main',
      );

      await createFeature({
        description: 'test feature',
        number: 42,
        cwd: '/repo',
      });

      expect(git().checkout).toHaveBeenCalledWith('main');
      expect(git().reset).toHaveBeenCalledWith(['--hard', 'origin/main']);
    });
  });

  // -------------------------------------------------------------------------
  // Test: epic branch uses reset --hard instead of pull
  // -------------------------------------------------------------------------
  describe('epic branch creation', () => {
    it('uses reset --hard instead of pull for epic parent branches', async () => {
      // Epic branch exists on remote
      (git().branch as ReturnType<typeof vi.fn>).mockResolvedValue({
        all: ['remotes/origin/epic-123'],
      });

      const result = await createFeature({
        description: 'test feature',
        number: 42,
        parent_epic_branch: 'epic-123',
        cwd: '/repo',
      });

      expect(result.success).toBe(true);
      expect(result.branched_from_epic).toBe(true);

      // Assert reset --hard was called with the epic branch
      expect(git().reset).toHaveBeenCalledWith(['--hard', 'origin/epic-123']);

      // Assert pull was NOT called
      expect(git().pull).not.toHaveBeenCalled();
    });

    it('creates branch from current HEAD when epic branch not found', async () => {
      (git().branch as ReturnType<typeof vi.fn>).mockResolvedValue({
        all: [],
      });

      const result = await createFeature({
        description: 'test feature',
        number: 42,
        parent_epic_branch: 'epic-nonexistent',
        cwd: '/repo',
      });

      expect(result.success).toBe(true);
      expect(git().checkoutLocalBranch).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Test: resume path (feature dir exists) returns early without syncing
  // -------------------------------------------------------------------------
  describe('resume path (feature dir exists)', () => {
    it('does not sync default branch when feature directory already exists', async () => {
      existsFor({
        '.git': true,
        'config.yaml': false,
        '042-test-feature': true, // feature dir exists
        'spec.md': true,
      });

      // Local branch exists — resume checks it out directly
      (git().branchLocal as ReturnType<typeof vi.fn>).mockResolvedValue({
        all: ['042-test-feature'],
        current: 'develop',
      });
      (git().revparse as ReturnType<typeof vi.fn>).mockResolvedValue('042-test-feature');

      const result = await createFeature({
        description: 'test feature',
        number: 42,
        cwd: '/repo',
      });

      expect(result.success).toBe(true);
      expect(result.git_branch_created).toBe(false);

      // Default-branch reset should NOT have been called
      const resetCalls = (git().reset as ReturnType<typeof vi.fn>).mock.calls;
      const defaultBranchReset = resetCalls.some(
        (call: unknown[]) =>
          Array.isArray(call[0]) &&
          call[0].includes('--hard') &&
          (call[0].includes('origin/develop') || call[0].includes('origin/main')),
      );
      expect(defaultBranchReset).toBe(false);
    });

    it('checks out existing local branch on resume', async () => {
      existsFor({
        '.git': true,
        'config.yaml': false,
        '042-test-feature': true,
        'spec.md': true,
      });

      (git().branchLocal as ReturnType<typeof vi.fn>).mockResolvedValue({
        all: ['042-test-feature'],
        current: 'develop',
      });
      (git().revparse as ReturnType<typeof vi.fn>).mockResolvedValue('042-test-feature');

      await createFeature({
        description: 'test feature',
        number: 42,
        cwd: '/repo',
      });

      expect(git().checkout).toHaveBeenCalledWith('042-test-feature');
    });

    it('creates branch from default when dir exists but no local or remote branch', async () => {
      existsFor({
        '.git': true,
        'config.yaml': false,
        '042-test-feature': true,
        'spec.md': false,
      });

      // No local branches contain the feature branch
      (git().branchLocal as ReturnType<typeof vi.fn>).mockResolvedValue({
        all: [],
        current: 'develop',
      });

      // No remote branches contain the feature branch
      (git().branch as ReturnType<typeof vi.fn>).mockResolvedValue({
        all: [],
      });

      // After branch creation, revparse returns the new branch name
      (git().revparse as ReturnType<typeof vi.fn>).mockResolvedValue('042-test-feature');

      const result = await createFeature({
        description: 'test feature',
        number: 42,
        cwd: '/repo',
      });

      expect(result.success).toBe(true);
      expect(result.git_branch_created).toBe(true);

      // Should have synced to default branch and created the feature branch
      expect(git().checkout).toHaveBeenCalledWith('develop');
      expect(git().reset).toHaveBeenCalledWith(['--hard', 'origin/develop']);
      expect(git().checkoutLocalBranch).toHaveBeenCalledWith('042-test-feature');
    });

    it('returns success: false when checkout fails silently (branch mismatch)', async () => {
      existsFor({
        '.git': true,
        'config.yaml': false,
        '042-test-feature': true,
        'spec.md': false,
      });

      (git().branchLocal as ReturnType<typeof vi.fn>).mockResolvedValue({
        all: ['042-test-feature'],
        current: 'develop',
      });

      // Simulate checkout not actually switching branches
      (git().revparse as ReturnType<typeof vi.fn>).mockResolvedValue('develop');

      const result = await createFeature({
        description: 'test feature',
        number: 42,
        cwd: '/repo',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Branch checkout failed');
    });

    it('sets git_branch_created to true when branch is newly created in resume path', async () => {
      existsFor({
        '.git': true,
        'config.yaml': false,
        '042-test-feature': true,
        'spec.md': false,
      });

      (git().branchLocal as ReturnType<typeof vi.fn>).mockResolvedValue({
        all: [],
        current: 'develop',
      });
      (git().branch as ReturnType<typeof vi.fn>).mockResolvedValue({
        all: [],
      });
      // After branch creation, revparse returns the new branch name
      (git().revparse as ReturnType<typeof vi.fn>).mockResolvedValue('042-test-feature');

      const result = await createFeature({
        description: 'test feature',
        number: 42,
        cwd: '/repo',
      });

      expect(result.success).toBe(true);
      expect(result.git_branch_created).toBe(true);
    });

    it('logs a warning when git fetch fails in resume path', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      existsFor({
        '.git': true,
        'config.yaml': false,
        '042-test-feature': true,
        'spec.md': true,
      });

      (git().branchLocal as ReturnType<typeof vi.fn>).mockResolvedValue({
        all: ['042-test-feature'],
        current: 'develop',
      });
      (git().fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'));
      (git().revparse as ReturnType<typeof vi.fn>).mockResolvedValue('042-test-feature');

      const result = await createFeature({
        description: 'test feature',
        number: 42,
        cwd: '/repo',
      });

      expect(result.success).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('git fetch failed'),
      );

      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Test: base_commit SHA is returned in output
  // -------------------------------------------------------------------------
  describe('base_commit output', () => {
    it('returns base_commit SHA for new branches from default branch', async () => {
      (git().revparse as ReturnType<typeof vi.fn>).mockImplementation(async (args: string[]) => {
        if (Array.isArray(args) && args.includes('--abbrev-ref')) return '042-test-feature';
        return 'deadbeef1234';
      });

      const result = await createFeature({
        description: 'test feature',
        number: 42,
        cwd: '/repo',
      });

      expect(result.success).toBe(true);
      expect(result.base_commit).toBe('deadbeef1234');
    });

    it('returns base_commit SHA for branches from epic parent', async () => {
      (git().branch as ReturnType<typeof vi.fn>).mockResolvedValue({
        all: ['remotes/origin/epic-123'],
      });
      (git().revparse as ReturnType<typeof vi.fn>).mockImplementation(async (args: string[]) => {
        if (Array.isArray(args) && args.includes('--abbrev-ref')) return '042-test-feature';
        return 'epic-sha-5678';
      });

      const result = await createFeature({
        description: 'test feature',
        number: 42,
        parent_epic_branch: 'epic-123',
        cwd: '/repo',
      });

      expect(result.success).toBe(true);
      expect(result.base_commit).toBe('epic-sha-5678');
    });

    it('returns base_commit SHA when epic branch not found (fallback)', async () => {
      (git().branch as ReturnType<typeof vi.fn>).mockResolvedValue({
        all: [],
      });
      (git().revparse as ReturnType<typeof vi.fn>).mockImplementation(async (args: string[]) => {
        if (Array.isArray(args) && args.includes('--abbrev-ref')) return '042-test-feature';
        return 'fallback-sha-9999';
      });

      const result = await createFeature({
        description: 'test feature',
        number: 42,
        parent_epic_branch: 'epic-nonexistent',
        cwd: '/repo',
      });

      expect(result.success).toBe(true);
      expect(result.base_commit).toBe('fallback-sha-9999');
    });
  });
});

// ---------------------------------------------------------------------------
// getDefaultBranch() tests
// ---------------------------------------------------------------------------

describe('getDefaultBranch()', () => {
  let mockGit: SimpleGit;

  beforeEach(() => {
    mockGit = createMockGit();
  });

  it('resolves default branch from symbolic-ref', async () => {
    (mockGit.raw as ReturnType<typeof vi.fn>).mockResolvedValue(
      'refs/remotes/origin/main',
    );

    const result = await getDefaultBranch(mockGit);
    expect(result).toBe('main');

    expect(mockGit.raw).toHaveBeenCalledWith([
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
    ]);
  });

  it('resolves develop when symbolic-ref returns develop', async () => {
    (mockGit.raw as ReturnType<typeof vi.fn>).mockResolvedValue(
      'refs/remotes/origin/develop',
    );

    const result = await getDefaultBranch(mockGit);
    expect(result).toBe('develop');
  });

  it('falls back to develop on error', async () => {
    (mockGit.raw as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref'),
    );

    const result = await getDefaultBranch(mockGit);
    expect(result).toBe('develop');
  });

  it('falls back to develop when symbolic-ref returns empty string', async () => {
    (mockGit.raw as ReturnType<typeof vi.fn>).mockResolvedValue('');

    const result = await getDefaultBranch(mockGit);
    expect(result).toBe('develop');
  });
});
