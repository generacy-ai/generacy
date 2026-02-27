import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

vi.mock('@clack/prompts', () => ({
  log: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../../../../config/index.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../../utils/logger.js', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../repo-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repo-utils.js')>();
  return {
    ...actual,
    // Keep real implementations for normalizeRepoUrl
    normalizeRepoUrl: actual.normalizeRepoUrl,
    // Mock detectPrimaryRepo — controlled per test
    detectPrimaryRepo: vi.fn(),
  };
});

vi.mock('../prompts.js', () => ({
  runInteractivePrompts: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import * as p from '@clack/prompts';
import { loadConfig } from '../../../../config/index.js';
import { detectPrimaryRepo } from '../repo-utils.js';
import { runInteractivePrompts } from '../prompts.js';
import { resolveOptions, ResolverError } from '../resolver.js';
import type { InitOptions } from '../types.js';

const mockLoadConfig = vi.mocked(loadConfig);
const mockDetectPrimaryRepo = vi.mocked(detectPrimaryRepo);
const mockRunInteractivePrompts = vi.mocked(runInteractivePrompts);
const mockLogWarn = vi.mocked(p.log.warn);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GIT_ROOT = '/home/user/my-project';

/** Build a minimal set of CLI flags for a fully non-interactive run. */
function fullFlags(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectName: 'Test Project',
    primaryRepo: 'acme/app',
    yes: true,
    ...overrides,
  };
}

/** Build a valid GeneracyConfig mock return value. */
function mockConfig(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1',
    project: { id: 'proj_existing01', name: 'Existing Project' },
    repos: {
      primary: 'github.com/acme/existing-app',
      dev: ['github.com/acme/lib'],
      clone: ['github.com/acme/docs'],
    },
    defaults: { agent: 'cursor-agent', baseBranch: 'develop' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  // Default: loadConfig throws (no existing config)
  mockLoadConfig.mockImplementation(() => {
    throw new Error('No config found');
  });
  // Default: detectPrimaryRepo returns null
  mockDetectPrimaryRepo.mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// CLI flags take priority
// ---------------------------------------------------------------------------

describe('resolveOptions', () => {
  describe('CLI flags take priority over all other sources', () => {
    it('uses CLI flags when all values are provided', async () => {
      const result = await resolveOptions(
        {
          projectName: 'From Flags',
          primaryRepo: 'acme/flagged-app',
          devRepo: ['acme/flagged-lib'],
          cloneRepo: ['acme/flagged-docs'],
          agent: 'cursor-agent',
          baseBranch: 'develop',
          releaseStream: 'preview',
          force: true,
          dryRun: true,
          skipGithubCheck: true,
          yes: true,
          verbose: true,
        },
        GIT_ROOT,
      );

      expect(result.projectName).toBe('From Flags');
      expect(result.primaryRepo).toBe('acme/flagged-app');
      expect(result.devRepos).toEqual(['acme/flagged-lib']);
      expect(result.cloneRepos).toEqual(['acme/flagged-docs']);
      expect(result.agent).toBe('cursor-agent');
      expect(result.baseBranch).toBe('develop');
      expect(result.releaseStream).toBe('preview');
      expect(result.force).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.skipGithubCheck).toBe(true);
      expect(result.yes).toBe(true);
      expect(result.verbose).toBe(true);
    });

    it('CLI flags override existing config values', async () => {
      mockLoadConfig.mockReturnValue(mockConfig());

      const result = await resolveOptions(
        {
          projectName: 'Flag Name',
          primaryRepo: 'acme/flag-repo',
          agent: 'claude-code',
          baseBranch: 'main',
          yes: true,
        },
        GIT_ROOT,
      );

      // CLI flags should override config values
      expect(result.projectName).toBe('Flag Name');
      expect(result.primaryRepo).toBe('acme/flag-repo');
      expect(result.agent).toBe('claude-code');
      expect(result.baseBranch).toBe('main');
    });

    it('does not invoke interactive prompts when --yes is set', async () => {
      await resolveOptions(fullFlags(), GIT_ROOT);

      expect(mockRunInteractivePrompts).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // --yes auto-derives values
  // -------------------------------------------------------------------------

  describe('--yes auto-derives values', () => {
    it('auto-derives project name from directory basename', async () => {
      const result = await resolveOptions(
        {
          primaryRepo: 'acme/app',
          yes: true,
        },
        '/home/user/my-cool-project',
      );

      expect(result.projectName).toBe('my-cool-project');
      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining('my-cool-project'),
      );
    });

    it('auto-derives primary repo from git remote', async () => {
      mockDetectPrimaryRepo.mockReturnValue('acme/detected-app');

      const result = await resolveOptions(
        {
          projectName: 'Test',
          yes: true,
        },
        GIT_ROOT,
      );

      expect(result.primaryRepo).toBe('acme/detected-app');
      expect(mockDetectPrimaryRepo).toHaveBeenCalledWith(GIT_ROOT);
      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining('acme/detected-app'),
      );
    });

    it('auto-derives both project name and primary repo', async () => {
      mockDetectPrimaryRepo.mockReturnValue('acme/auto-app');

      const result = await resolveOptions(
        { yes: true },
        '/workspace/auto-project',
      );

      expect(result.projectName).toBe('auto-project');
      expect(result.primaryRepo).toBe('acme/auto-app');
    });

    it('fails when primary repo cannot be auto-detected with --yes', async () => {
      mockDetectPrimaryRepo.mockReturnValue(null);

      await expect(
        resolveOptions(
          { projectName: 'Test', yes: true },
          GIT_ROOT,
        ),
      ).rejects.toThrow(ResolverError);

      await expect(
        resolveOptions(
          { projectName: 'Test', yes: true },
          GIT_ROOT,
        ),
      ).rejects.toThrow(/Cannot auto-detect primary repository/);
    });

    it('defaults devRepos and cloneRepos to empty arrays with --yes', async () => {
      const result = await resolveOptions(fullFlags(), GIT_ROOT);

      expect(result.devRepos).toEqual([]);
      expect(result.cloneRepos).toEqual([]);
    });

    it('does not auto-derive project name when provided via flags', async () => {
      const result = await resolveOptions(
        {
          projectName: 'Explicit Name',
          primaryRepo: 'acme/app',
          yes: true,
        },
        GIT_ROOT,
      );

      expect(result.projectName).toBe('Explicit Name');
      // Should NOT warn about auto-derived project name
      expect(mockLogWarn).not.toHaveBeenCalledWith(
        expect.stringContaining('project name'),
      );
    });

    it('does not auto-derive primary repo when provided via flags', async () => {
      const result = await resolveOptions(
        {
          projectName: 'Test',
          primaryRepo: 'acme/explicit',
          yes: true,
        },
        GIT_ROOT,
      );

      expect(result.primaryRepo).toBe('acme/explicit');
      expect(mockDetectPrimaryRepo).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Non-TTY without --yes produces error
  // -------------------------------------------------------------------------

  describe('non-TTY error handling', () => {
    it('throws when prompts are needed in non-TTY environment', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      try {
        await expect(
          resolveOptions({}, GIT_ROOT),
        ).rejects.toThrow(ResolverError);

        await expect(
          resolveOptions({}, GIT_ROOT),
        ).rejects.toThrow(/non-TTY/);
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', {
          value: originalIsTTY,
          configurable: true,
        });
      }
    });

    it('suggests using --yes or providing all flags in non-TTY error', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      try {
        await expect(
          resolveOptions({}, GIT_ROOT),
        ).rejects.toThrow(/--yes/);
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', {
          value: originalIsTTY,
          configurable: true,
        });
      }
    });

    it('does not throw non-TTY error when fully specified by flags', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      try {
        // Fully specified — no prompts needed, should not throw
        const result = await resolveOptions(fullFlags(), GIT_ROOT);
        expect(result.projectName).toBe('Test Project');
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', {
          value: originalIsTTY,
          configurable: true,
        });
      }
    });
  });

  // -------------------------------------------------------------------------
  // Interactive prompts
  // -------------------------------------------------------------------------

  describe('interactive prompts', () => {
    it('runs interactive prompts when not fully specified and TTY is available', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      mockRunInteractivePrompts.mockResolvedValue({
        projectName: 'Prompted Name',
        primaryRepo: 'acme/prompted',
        devRepos: [],
        cloneRepos: [],
        agent: 'claude-code',
        baseBranch: 'main',
      });

      try {
        const result = await resolveOptions({}, GIT_ROOT);

        expect(mockRunInteractivePrompts).toHaveBeenCalledTimes(1);
        expect(result.projectName).toBe('Prompted Name');
        expect(result.primaryRepo).toBe('acme/prompted');
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', {
          value: originalIsTTY,
          configurable: true,
        });
      }
    });

    it('passes merged flags and config as defaults to prompts', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      // Only pass agent flag — not enough for isFullySpecified, so prompts run
      mockRunInteractivePrompts.mockResolvedValue({
        projectName: 'Prompted Name',
        primaryRepo: 'acme/prompted',
        devRepos: [],
        cloneRepos: [],
        agent: 'claude-code',
        baseBranch: 'main',
      });

      try {
        await resolveOptions({ agent: 'claude-code' }, GIT_ROOT);

        expect(mockRunInteractivePrompts).toHaveBeenCalledTimes(1);
        // Check that the CLI flag was passed through as a default
        const callArgs = mockRunInteractivePrompts.mock.calls[0]!;
        const defaults = callArgs[0] as Partial<InitOptions>;
        expect(defaults.agent).toBe('claude-code'); // CLI flag passed as default
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', {
          value: originalIsTTY,
          configurable: true,
        });
      }
    });

    it('skips prompts when fully specified without --yes', async () => {
      const result = await resolveOptions(
        {
          projectName: 'Full',
          primaryRepo: 'acme/full',
        },
        GIT_ROOT,
      );

      expect(mockRunInteractivePrompts).not.toHaveBeenCalled();
      expect(result.projectName).toBe('Full');
    });
  });

  // -------------------------------------------------------------------------
  // Existing config values pre-fill defaults
  // -------------------------------------------------------------------------

  describe('existing config pre-fills defaults', () => {
    it('loads existing config and uses values as defaults', async () => {
      mockLoadConfig.mockReturnValue(mockConfig());

      // With --yes, the config values should be used if not overridden by flags
      const result = await resolveOptions({ yes: true }, GIT_ROOT);

      expect(result.projectName).toBe('Existing Project');
      expect(result.primaryRepo).toBe('acme/existing-app');
      expect(result.agent).toBe('cursor-agent');
      expect(result.baseBranch).toBe('develop');
    });

    it('normalizes config repo URLs from config format to shorthand', async () => {
      mockLoadConfig.mockReturnValue(mockConfig());

      const result = await resolveOptions({ yes: true }, GIT_ROOT);

      // Config stores github.com/owner/repo, resolver should normalize
      expect(result.primaryRepo).toBe('acme/existing-app');
      expect(result.devRepos).toEqual(['acme/lib']);
      expect(result.cloneRepos).toEqual(['acme/docs']);
    });

    it('handles config with no dev or clone repos', async () => {
      mockLoadConfig.mockReturnValue(
        mockConfig({
          repos: { primary: 'github.com/acme/simple' },
        }),
      );

      const result = await resolveOptions({ yes: true }, GIT_ROOT);

      expect(result.primaryRepo).toBe('acme/simple');
      expect(result.devRepos).toEqual([]);
      expect(result.cloneRepos).toEqual([]);
    });

    it('handles config with missing defaults section', async () => {
      mockLoadConfig.mockReturnValue(
        mockConfig({ defaults: undefined }),
      );

      const result = await resolveOptions({ yes: true }, GIT_ROOT);

      // Should fall back to hard-coded defaults
      expect(result.agent).toBe('claude-code');
      expect(result.baseBranch).toBe('main');
    });

    it('gracefully handles config loading failure', async () => {
      mockLoadConfig.mockImplementation(() => {
        throw new Error('Config invalid');
      });

      // With --yes, auto-derive the rest
      mockDetectPrimaryRepo.mockReturnValue('acme/fallback');

      const result = await resolveOptions({ yes: true }, GIT_ROOT);

      // Should work — just no config defaults
      expect(result.projectName).toBe('my-project'); // from basename
      expect(result.primaryRepo).toBe('acme/fallback');
    });
  });

  // -------------------------------------------------------------------------
  // Project ID generation and validation
  // -------------------------------------------------------------------------

  describe('project ID', () => {
    it('uses provided --project-id when valid', async () => {
      const result = await resolveOptions(
        fullFlags({ projectId: 'proj_abc123xyz' }),
        GIT_ROOT,
      );

      expect(result.projectId).toBe('proj_abc123xyz');
    });

    it('rejects project ID without proj_ prefix', async () => {
      await expect(
        resolveOptions(
          fullFlags({ projectId: 'invalid_id' }),
          GIT_ROOT,
        ),
      ).rejects.toThrow(ResolverError);

      await expect(
        resolveOptions(
          fullFlags({ projectId: 'invalid_id' }),
          GIT_ROOT,
        ),
      ).rejects.toThrow(/Invalid project ID/);
    });

    it('rejects project ID shorter than 12 characters', async () => {
      await expect(
        resolveOptions(
          fullFlags({ projectId: 'proj_ab' }),
          GIT_ROOT,
        ),
      ).rejects.toThrow(ResolverError);

      await expect(
        resolveOptions(
          fullFlags({ projectId: 'proj_ab' }),
          GIT_ROOT,
        ),
      ).rejects.toThrow(/at least 12 characters/);
    });

    it('rejects project ID with uppercase letters', async () => {
      await expect(
        resolveOptions(
          fullFlags({ projectId: 'proj_ABC123xyz' }),
          GIT_ROOT,
        ),
      ).rejects.toThrow(ResolverError);
    });

    it('rejects project ID with special characters', async () => {
      await expect(
        resolveOptions(
          fullFlags({ projectId: 'proj_abc-123' }),
          GIT_ROOT,
        ),
      ).rejects.toThrow(ResolverError);
    });

    it('generates local placeholder ID when no project ID provided', async () => {
      const result = await resolveOptions(fullFlags(), GIT_ROOT);

      expect(result.projectId).toMatch(/^proj_local_[0-9a-f]{8}$/);
    });

    it('generates unique local IDs on each call', async () => {
      const result1 = await resolveOptions(fullFlags(), GIT_ROOT);
      const result2 = await resolveOptions(fullFlags(), GIT_ROOT);

      expect(result1.projectId).toMatch(/^proj_local_/);
      expect(result2.projectId).toMatch(/^proj_local_/);
      // Technically could collide, but astronomically unlikely with 4 random bytes
      expect(result1.projectId).not.toBe(result2.projectId);
    });

    it('uses project ID from existing config when available', async () => {
      mockLoadConfig.mockReturnValue(mockConfig());

      const result = await resolveOptions(
        { projectName: 'Test', primaryRepo: 'acme/app', yes: true },
        GIT_ROOT,
      );

      expect(result.projectId).toBe('proj_existing01');
    });

    it('CLI --project-id overrides config project ID', async () => {
      mockLoadConfig.mockReturnValue(mockConfig());

      const result = await resolveOptions(
        {
          projectId: 'proj_override01',
          projectName: 'Test',
          primaryRepo: 'acme/app',
          yes: true,
        },
        GIT_ROOT,
      );

      expect(result.projectId).toBe('proj_override01');
    });
  });

  // -------------------------------------------------------------------------
  // Repo URL normalization
  // -------------------------------------------------------------------------

  describe('repo URL normalization', () => {
    it('normalizes primary repo from HTTPS format', async () => {
      const result = await resolveOptions(
        fullFlags({ primaryRepo: 'https://github.com/acme/app.git' }),
        GIT_ROOT,
      );

      expect(result.primaryRepo).toBe('acme/app');
    });

    it('normalizes primary repo from SSH format', async () => {
      const result = await resolveOptions(
        fullFlags({ primaryRepo: 'git@github.com:acme/app.git' }),
        GIT_ROOT,
      );

      expect(result.primaryRepo).toBe('acme/app');
    });

    it('normalizes primary repo from bare domain format', async () => {
      const result = await resolveOptions(
        fullFlags({ primaryRepo: 'github.com/acme/app' }),
        GIT_ROOT,
      );

      expect(result.primaryRepo).toBe('acme/app');
    });

    it('normalizes dev repo URLs', async () => {
      const result = await resolveOptions(
        fullFlags({
          devRepo: [
            'https://github.com/acme/lib.git',
            'git@github.com:acme/utils.git',
          ],
        }),
        GIT_ROOT,
      );

      expect(result.devRepos).toEqual(['acme/lib', 'acme/utils']);
    });

    it('normalizes clone repo URLs', async () => {
      const result = await resolveOptions(
        fullFlags({
          cloneRepo: ['github.com/acme/docs', 'https://github.com/acme/wiki'],
        }),
        GIT_ROOT,
      );

      expect(result.cloneRepos).toEqual(['acme/docs', 'acme/wiki']);
    });

    it('throws ResolverError for invalid repo URL', async () => {
      await expect(
        resolveOptions(
          fullFlags({ primaryRepo: 'not-a-valid-repo' }),
          GIT_ROOT,
        ),
      ).rejects.toThrow(ResolverError);
    });

    it('throws ResolverError for invalid dev repo URL', async () => {
      await expect(
        resolveOptions(
          fullFlags({ devRepo: ['invalid-format'] }),
          GIT_ROOT,
        ),
      ).rejects.toThrow(ResolverError);
    });

    it('keeps shorthand repos unchanged', async () => {
      const result = await resolveOptions(
        fullFlags({ primaryRepo: 'acme/app' }),
        GIT_ROOT,
      );

      expect(result.primaryRepo).toBe('acme/app');
    });
  });

  // -------------------------------------------------------------------------
  // Duplicate repo name detection
  // -------------------------------------------------------------------------

  describe('duplicate repo detection', () => {
    it('throws when primary repo appears in dev repos', async () => {
      await expect(
        resolveOptions(
          fullFlags({
            primaryRepo: 'acme/app',
            devRepo: ['acme/app'],
          }),
          GIT_ROOT,
        ),
      ).rejects.toThrow(ResolverError);

      await expect(
        resolveOptions(
          fullFlags({
            primaryRepo: 'acme/app',
            devRepo: ['acme/app'],
          }),
          GIT_ROOT,
        ),
      ).rejects.toThrow(/Duplicate repository/);
    });

    it('throws when primary repo appears in clone repos', async () => {
      await expect(
        resolveOptions(
          fullFlags({
            primaryRepo: 'acme/app',
            cloneRepo: ['acme/app'],
          }),
          GIT_ROOT,
        ),
      ).rejects.toThrow(/Duplicate repository/);
    });

    it('throws when dev repo appears in clone repos', async () => {
      await expect(
        resolveOptions(
          fullFlags({
            devRepo: ['acme/shared'],
            cloneRepo: ['acme/shared'],
          }),
          GIT_ROOT,
        ),
      ).rejects.toThrow(/Duplicate repository/);
    });

    it('detects duplicates after URL normalization', async () => {
      await expect(
        resolveOptions(
          fullFlags({
            primaryRepo: 'acme/app',
            devRepo: ['https://github.com/acme/app.git'],
          }),
          GIT_ROOT,
        ),
      ).rejects.toThrow(/Duplicate repository/);
    });

    it('allows different repos in different roles', async () => {
      const result = await resolveOptions(
        fullFlags({
          primaryRepo: 'acme/app',
          devRepo: ['acme/lib'],
          cloneRepo: ['acme/docs'],
        }),
        GIT_ROOT,
      );

      expect(result.primaryRepo).toBe('acme/app');
      expect(result.devRepos).toEqual(['acme/lib']);
      expect(result.cloneRepos).toEqual(['acme/docs']);
    });

    it('error message mentions both conflicting roles', async () => {
      await expect(
        resolveOptions(
          fullFlags({
            primaryRepo: 'acme/app',
            devRepo: ['acme/app'],
          }),
          GIT_ROOT,
        ),
      ).rejects.toThrow(/primary.*dev/);
    });
  });

  // -------------------------------------------------------------------------
  // Default values
  // -------------------------------------------------------------------------

  describe('default values', () => {
    it('defaults agent to claude-code', async () => {
      const result = await resolveOptions(fullFlags(), GIT_ROOT);

      expect(result.agent).toBe('claude-code');
    });

    it('defaults baseBranch to main', async () => {
      const result = await resolveOptions(fullFlags(), GIT_ROOT);

      expect(result.baseBranch).toBe('main');
    });

    it('defaults releaseStream to stable', async () => {
      const result = await resolveOptions(fullFlags(), GIT_ROOT);

      expect(result.releaseStream).toBe('stable');
    });

    it('defaults force to false', async () => {
      const result = await resolveOptions(fullFlags(), GIT_ROOT);

      expect(result.force).toBe(false);
    });

    it('defaults dryRun to false', async () => {
      const result = await resolveOptions(fullFlags(), GIT_ROOT);

      expect(result.dryRun).toBe(false);
    });

    it('defaults skipGithubCheck to false', async () => {
      const result = await resolveOptions(fullFlags(), GIT_ROOT);

      expect(result.skipGithubCheck).toBe(false);
    });

    it('defaults verbose to false', async () => {
      const result = await resolveOptions(fullFlags(), GIT_ROOT);

      expect(result.verbose).toBe(false);
    });

    it('defaults devRepos to empty array', async () => {
      const result = await resolveOptions(fullFlags(), GIT_ROOT);

      expect(result.devRepos).toEqual([]);
    });

    it('defaults cloneRepos to empty array', async () => {
      const result = await resolveOptions(fullFlags(), GIT_ROOT);

      expect(result.cloneRepos).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Flag extraction edge cases
  // -------------------------------------------------------------------------

  describe('flag extraction', () => {
    it('ignores unknown flag properties', async () => {
      const result = await resolveOptions(
        fullFlags({ unknownFlag: 'should be ignored' }),
        GIT_ROOT,
      );

      expect(result.projectName).toBe('Test Project');
      expect((result as Record<string, unknown>).unknownFlag).toBeUndefined();
    });

    it('filters non-string values from variadic dev repo flag', async () => {
      const result = await resolveOptions(
        fullFlags({ devRepo: ['acme/lib', 42, null, 'acme/utils'] as unknown[] }),
        GIT_ROOT,
      );

      expect(result.devRepos).toEqual(['acme/lib', 'acme/utils']);
    });

    it('handles empty variadic arrays', async () => {
      const result = await resolveOptions(
        fullFlags({ devRepo: [], cloneRepo: [] }),
        GIT_ROOT,
      );

      expect(result.devRepos).toEqual([]);
      expect(result.cloneRepos).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // ResolverError type
  // -------------------------------------------------------------------------

  describe('ResolverError', () => {
    it('has correct name', () => {
      const error = new ResolverError('test');
      expect(error.name).toBe('ResolverError');
    });

    it('is an instance of Error', () => {
      const error = new ResolverError('test');
      expect(error).toBeInstanceOf(Error);
    });

    it('preserves the message', () => {
      const error = new ResolverError('something went wrong');
      expect(error.message).toBe('something went wrong');
    });
  });
});
