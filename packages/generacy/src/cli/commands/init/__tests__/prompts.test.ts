import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  text: vi.fn(),
  select: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
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
    // Keep real implementations — the prompts module uses these for validation
    parseRepoUrl: actual.parseRepoUrl,
    toShorthand: actual.toShorthand,
    normalizeRepoUrl: actual.normalizeRepoUrl,
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import * as p from '@clack/prompts';
import { loadConfig } from '../../../../config/index.js';
import { runInteractivePrompts } from '../prompts.js';
import type { InitOptions } from '../types.js';

const mockText = vi.mocked(p.text);
const mockSelect = vi.mocked(p.select);
const mockIntro = vi.mocked(p.intro);
const mockIsCancel = vi.mocked(p.isCancel);
const mockCancel = vi.mocked(p.cancel);
const mockLoadConfig = vi.mocked(loadConfig);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GIT_ROOT = '/home/user/my-project';

/** Build a set of defaults where every field is provided (nothing to prompt). */
function allDefaults(): Partial<InitOptions> {
  return {
    projectName: 'My Project',
    primaryRepo: 'acme/app',
    devRepos: ['acme/lib'],
    cloneRepos: ['acme/docs'],
    agent: 'claude-code',
    baseBranch: 'main',
    variant: 'standard',
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  // Default: isCancel returns false (user did not cancel)
  mockIsCancel.mockReturnValue(false);
  // Default: loadConfig throws so no existing config is loaded
  mockLoadConfig.mockImplementation(() => {
    throw new Error('No config found');
  });
});

// ---------------------------------------------------------------------------
// Full prompt flow (no defaults)
// ---------------------------------------------------------------------------

describe('runInteractivePrompts', () => {
  describe('full prompt flow (no defaults)', () => {
    it('runs all prompts when no defaults are provided', async () => {
      // Arrange — mock each prompt return value in call order
      // select: cluster variant, then agent
      mockSelect
        .mockResolvedValueOnce('standard')              // cluster variant
        .mockResolvedValueOnce('claude-code');           // agent
      mockText
        .mockResolvedValueOnce('Test Project')       // project name
        .mockResolvedValueOnce('acme/app')            // primary repo
        .mockResolvedValueOnce('')                     // dev repos (empty)
        .mockResolvedValueOnce('main');                // base branch

      // Act
      const result = await runInteractivePrompts({}, GIT_ROOT);

      // Assert
      expect(mockIntro).toHaveBeenCalledWith('generacy init');
      expect(mockText).toHaveBeenCalledTimes(4); // name, primary, dev repos, base branch
      expect(mockSelect).toHaveBeenCalledTimes(2); // variant + agent
      expect(result.projectName).toBe('Test Project');
      expect(result.primaryRepo).toBe('acme/app');
      expect(result.devRepos).toEqual([]);
      expect(result.agent).toBe('claude-code');
      expect(result.baseBranch).toBe('main');
      expect(result.cloneRepos).toEqual([]);
    });

    it('prompts for clone repos when dev repos are provided', async () => {
      mockSelect
        .mockResolvedValueOnce('standard')              // cluster variant
        .mockResolvedValueOnce('cursor-agent');          // agent
      mockText
        .mockResolvedValueOnce('Test Project')       // project name
        .mockResolvedValueOnce('acme/app')            // primary repo
        .mockResolvedValueOnce('acme/lib')            // dev repos
        .mockResolvedValueOnce('acme/docs')           // clone repos
        .mockResolvedValueOnce('develop');             // base branch

      const result = await runInteractivePrompts({}, GIT_ROOT);

      expect(mockText).toHaveBeenCalledTimes(5); // name, primary, dev, clone, branch
      expect(result.devRepos).toEqual(['acme/lib']);
      expect(result.cloneRepos).toEqual(['acme/docs']);
      expect(result.agent).toBe('cursor-agent');
      expect(result.baseBranch).toBe('develop');
    });

    it('normalizes primary repo URL from HTTPS format', async () => {
      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('Project')
        .mockResolvedValueOnce('https://github.com/acme/app.git')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('main');

      const result = await runInteractivePrompts({}, GIT_ROOT);

      expect(result.primaryRepo).toBe('acme/app');
    });

    it('normalizes dev repo URLs from comma-separated list', async () => {
      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('Project')
        .mockResolvedValueOnce('acme/app')
        .mockResolvedValueOnce('https://github.com/acme/lib.git, git@github.com:acme/utils.git')
        .mockResolvedValueOnce('')                    // clone repos
        .mockResolvedValueOnce('main');

      const result = await runInteractivePrompts({}, GIT_ROOT);

      expect(result.devRepos).toEqual(['acme/lib', 'acme/utils']);
    });
  });

  // -------------------------------------------------------------------------
  // Prompt skipping when defaults are provided
  // -------------------------------------------------------------------------

  describe('skipping prompts via defaults', () => {
    it('skips all prompts when all defaults are provided', async () => {
      const result = await runInteractivePrompts(allDefaults(), GIT_ROOT);

      expect(mockIntro).toHaveBeenCalled();
      expect(mockText).not.toHaveBeenCalled();
      expect(mockSelect).not.toHaveBeenCalled();
      expect(result.projectName).toBe('My Project');
      expect(result.primaryRepo).toBe('acme/app');
      expect(result.devRepos).toEqual(['acme/lib']);
      expect(result.cloneRepos).toEqual(['acme/docs']);
      expect(result.agent).toBe('claude-code');
      expect(result.baseBranch).toBe('main');
    });

    it('skips project name prompt when projectName default is set', async () => {
      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('acme/app')   // primary repo
        .mockResolvedValueOnce('')            // dev repos
        .mockResolvedValueOnce('main');       // base branch

      const result = await runInteractivePrompts({ projectName: 'Given Name' }, GIT_ROOT);

      expect(result.projectName).toBe('Given Name');
      // text was called 3 times (primary, dev, branch) — NOT 4 (no name prompt)
      expect(mockText).toHaveBeenCalledTimes(3);
    });

    it('skips primary repo prompt when primaryRepo default is set', async () => {
      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('Project')    // project name
        .mockResolvedValueOnce('')            // dev repos
        .mockResolvedValueOnce('main');       // base branch

      const result = await runInteractivePrompts({ primaryRepo: 'acme/app' }, GIT_ROOT);

      expect(result.primaryRepo).toBe('acme/app');
      expect(mockText).toHaveBeenCalledTimes(3);
    });

    it('skips dev repos prompt when devRepos default is set', async () => {
      // devRepos provided → clone repos prompt IS shown (multi-repo flow)
      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('Project')    // project name
        .mockResolvedValueOnce('acme/app')   // primary repo
        .mockResolvedValueOnce('')            // clone repos (prompted because devRepos present)
        .mockResolvedValueOnce('main');       // base branch

      const result = await runInteractivePrompts({ devRepos: ['acme/lib'] }, GIT_ROOT);

      expect(result.devRepos).toEqual(['acme/lib']);
      // 4 text calls: name, primary, clone, branch (dev repos skipped)
      expect(mockText).toHaveBeenCalledTimes(4);
    });

    it('skips clone repos prompt when cloneRepos default is set', async () => {
      // With dev repos in defaults, clone repos would normally prompt
      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('Project')    // project name
        .mockResolvedValueOnce('acme/app')   // primary repo
        .mockResolvedValueOnce('acme/lib')   // dev repos — triggers multi-repo flow
        .mockResolvedValueOnce('main');       // base branch

      const result = await runInteractivePrompts({ cloneRepos: ['acme/docs'] }, GIT_ROOT);

      expect(result.cloneRepos).toEqual(['acme/docs']);
    });

    it('skips agent prompt when agent default is set', async () => {
      // Only variant select, no agent select
      mockSelect.mockResolvedValueOnce('standard');
      mockText
        .mockResolvedValueOnce('Project')
        .mockResolvedValueOnce('acme/app')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('main');

      const result = await runInteractivePrompts({ agent: 'cursor-agent' }, GIT_ROOT);

      expect(result.agent).toBe('cursor-agent');
      // Only 1 select call (variant), not 2 (variant + agent)
      expect(mockSelect).toHaveBeenCalledTimes(1);
    });

    it('skips base branch prompt when baseBranch default is set', async () => {
      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('Project')
        .mockResolvedValueOnce('acme/app')
        .mockResolvedValueOnce('');           // dev repos

      const result = await runInteractivePrompts({ baseBranch: 'develop' }, GIT_ROOT);

      expect(result.baseBranch).toBe('develop');
      // text: name, primary, dev repos — but NOT base branch
      expect(mockText).toHaveBeenCalledTimes(3);
    });

    it('does not prompt for clone repos when no dev repos are provided', async () => {
      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('Project')
        .mockResolvedValueOnce('acme/app')
        .mockResolvedValueOnce('')            // dev repos (empty)
        .mockResolvedValueOnce('main');

      const result = await runInteractivePrompts({}, GIT_ROOT);

      expect(result.cloneRepos).toEqual([]);
      // 4 text calls: name, primary, dev, branch — no clone repos prompt
      expect(mockText).toHaveBeenCalledTimes(4);
    });
  });

  // -------------------------------------------------------------------------
  // Cancel handling
  // -------------------------------------------------------------------------

  describe('cancel handling', () => {
    it('exits with code 130 when cluster variant is cancelled', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });
      mockIsCancel.mockReturnValue(true);
      mockSelect.mockResolvedValueOnce(Symbol('cancel') as unknown as string);

      await expect(runInteractivePrompts({}, GIT_ROOT)).rejects.toThrow('process.exit');

      expect(mockCancel).toHaveBeenCalledWith('Operation cancelled.');
      expect(mockExit).toHaveBeenCalledWith(130);
      mockExit.mockRestore();
    });

    it('exits with code 130 when project name is cancelled', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });
      // First select (variant) succeeds
      mockSelect.mockResolvedValueOnce('standard');
      mockIsCancel
        .mockReturnValueOnce(false)                     // variant not cancelled
        .mockReturnValueOnce(true);                     // project name cancelled
      mockText.mockResolvedValueOnce(Symbol('cancel') as unknown as string);

      await expect(runInteractivePrompts({}, GIT_ROOT)).rejects.toThrow('process.exit');

      expect(mockExit).toHaveBeenCalledWith(130);
      mockExit.mockRestore();
    });

    it('exits with code 130 when agent select is cancelled', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });
      mockSelect
        .mockResolvedValueOnce('standard')              // variant OK
        .mockResolvedValueOnce(Symbol('cancel') as unknown as string); // agent cancelled
      mockText
        .mockResolvedValueOnce('Project')
        .mockResolvedValueOnce('acme/app')
        .mockResolvedValueOnce('');                     // dev repos
      mockIsCancel
        .mockReturnValueOnce(false)                     // variant
        .mockReturnValueOnce(false)                     // project name
        .mockReturnValueOnce(false)                     // primary repo
        .mockReturnValueOnce(false)                     // dev repos
        .mockReturnValueOnce(true);                     // agent cancelled

      await expect(runInteractivePrompts({}, GIT_ROOT)).rejects.toThrow('process.exit');

      expect(mockExit).toHaveBeenCalledWith(130);
      mockExit.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Existing config detection
  // -------------------------------------------------------------------------

  describe('existing config detection', () => {
    it('loads existing config values as defaults', async () => {
      mockLoadConfig.mockReturnValue({
        schemaVersion: '1',
        project: { id: 'proj_abc123xyz', name: 'Existing Project' },
        repos: {
          primary: 'github.com/acme/existing-app',
          dev: ['github.com/acme/lib'],
          clone: ['github.com/acme/docs'],
        },
        defaults: { agent: 'cursor-agent', baseBranch: 'develop' },
      });

      // Mock prompts to return the initial/default values (simulating user pressing enter)
      mockSelect
        .mockResolvedValueOnce('standard')                // cluster variant
        .mockResolvedValueOnce('cursor-agent');            // agent (from config)
      mockText
        .mockResolvedValueOnce('Existing Project')          // project name (from config)
        .mockResolvedValueOnce('acme/existing-app')         // primary repo (normalized from config)
        .mockResolvedValueOnce('acme/lib')                  // dev repos (normalized from config)
        .mockResolvedValueOnce('acme/docs')                 // clone repos (normalized from config)
        .mockResolvedValueOnce('develop');                   // base branch (from config)

      const result = await runInteractivePrompts({}, GIT_ROOT);

      expect(result.projectName).toBe('Existing Project');
      expect(result.primaryRepo).toBe('acme/existing-app');
      expect(result.devRepos).toEqual(['acme/lib']);
      expect(result.cloneRepos).toEqual(['acme/docs']);
      expect(result.agent).toBe('cursor-agent');
      expect(result.baseBranch).toBe('develop');
    });

    it('falls back to empty defaults when config loading fails', async () => {
      mockLoadConfig.mockImplementation(() => {
        throw new Error('Config not found');
      });

      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('my-project')   // project name (dirname fallback)
        .mockResolvedValueOnce('acme/app')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('main');

      const result = await runInteractivePrompts({}, GIT_ROOT);

      // Should still work — just no pre-filled defaults from config
      expect(result.projectName).toBe('my-project');
      expect(result.baseBranch).toBe('main');
      expect(result.agent).toBe('claude-code');
    });

    it('normalizes config repo URLs from config format to shorthand', async () => {
      mockLoadConfig.mockReturnValue({
        schemaVersion: '1',
        project: { id: 'proj_abc123xyz', name: 'Config Project' },
        repos: {
          primary: 'github.com/acme/app',
          dev: ['github.com/acme/lib-a', 'github.com/acme/lib-b'],
        },
        defaults: {},
      });

      // The prompts should receive shorthand (owner/repo) values, not config format
      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('Config Project')
        .mockResolvedValueOnce('acme/app')               // normalized from github.com/acme/app
        .mockResolvedValueOnce('acme/lib-a, acme/lib-b') // normalized from config format
        .mockResolvedValueOnce('')                         // clone repos
        .mockResolvedValueOnce('main');

      const result = await runInteractivePrompts({}, GIT_ROOT);

      expect(result.primaryRepo).toBe('acme/app');
      expect(result.devRepos).toEqual(['acme/lib-a', 'acme/lib-b']);
    });

    it('handles config with no dev or clone repos', async () => {
      mockLoadConfig.mockReturnValue({
        schemaVersion: '1',
        project: { id: 'proj_abc123xyz', name: 'Simple Project' },
        repos: { primary: 'github.com/acme/app' },
        defaults: { agent: 'claude-code', baseBranch: 'main' },
      });

      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('Simple Project')
        .mockResolvedValueOnce('acme/app')
        .mockResolvedValueOnce('')             // dev repos (no config default)
        .mockResolvedValueOnce('main');

      const result = await runInteractivePrompts({}, GIT_ROOT);

      expect(result.devRepos).toEqual([]);
      expect(result.cloneRepos).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Validation of repo URL input during prompt
  // -------------------------------------------------------------------------

  describe('prompt validation', () => {
    it('passes validate function to project name prompt', async () => {
      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('Project')
        .mockResolvedValueOnce('acme/app')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('main');

      await runInteractivePrompts({}, GIT_ROOT);

      // The first text call is for project name — check it has a validate function
      const projectNameCall = mockText.mock.calls[0]![0] as { validate?: (value: string) => string | undefined };
      expect(projectNameCall.validate).toBeDefined();
      expect(projectNameCall.validate!('')).toBe('Project name cannot be empty');
      expect(projectNameCall.validate!('   ')).toBe('Project name cannot be empty');
      expect(projectNameCall.validate!('Valid Name')).toBeUndefined();
      expect(projectNameCall.validate!('a'.repeat(256))).toBe('Project name cannot exceed 255 characters');
    });

    it('passes validate function to primary repo prompt', async () => {
      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('Project')
        .mockResolvedValueOnce('acme/app')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('main');

      await runInteractivePrompts({}, GIT_ROOT);

      // The second text call is for primary repo
      const primaryRepoCall = mockText.mock.calls[1]![0] as { validate?: (value: string) => string | undefined };
      expect(primaryRepoCall.validate).toBeDefined();
      expect(primaryRepoCall.validate!('')).toBe('Primary repository is required');
      expect(primaryRepoCall.validate!('acme/app')).toBeUndefined();
      expect(primaryRepoCall.validate!('not-valid')).toBeDefined();
    });

    it('passes validate function to dev repos prompt', async () => {
      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('Project')
        .mockResolvedValueOnce('acme/app')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('main');

      await runInteractivePrompts({}, GIT_ROOT);

      // The third text call is for dev repos
      const devReposCall = mockText.mock.calls[2]![0] as { validate?: (value: string) => string | undefined };
      expect(devReposCall.validate).toBeDefined();
      // Empty is valid (optional field)
      expect(devReposCall.validate!('')).toBeUndefined();
      // Valid comma-separated repos
      expect(devReposCall.validate!('acme/lib, acme/utils')).toBeUndefined();
      // Invalid repo format
      expect(devReposCall.validate!('not-valid')).toBeDefined();
    });

    it('passes validate function to base branch prompt', async () => {
      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('Project')
        .mockResolvedValueOnce('acme/app')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('main');

      await runInteractivePrompts({}, GIT_ROOT);

      // The fourth text call is for base branch
      const baseBranchCall = mockText.mock.calls[3]![0] as { validate?: (value: string) => string | undefined };
      expect(baseBranchCall.validate).toBeDefined();
      expect(baseBranchCall.validate!('')).toBe('Base branch cannot be empty');
      expect(baseBranchCall.validate!('   ')).toBe('Base branch cannot be empty');
      expect(baseBranchCall.validate!('main')).toBeUndefined();
    });

    it('provides correct agent select options', async () => {
      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('Project')
        .mockResolvedValueOnce('acme/app')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('main');

      await runInteractivePrompts({}, GIT_ROOT);

      // Second select call is for agent (first is variant)
      const agentSelectCall = mockSelect.mock.calls[1]![0] as {
        options: Array<{ value: string; label: string }>;
      };
      expect(agentSelectCall.options).toHaveLength(2);
      expect(agentSelectCall.options[0]!.value).toBe('claude-code');
      expect(agentSelectCall.options[1]!.value).toBe('cursor-agent');
    });
  });

  // -------------------------------------------------------------------------
  // Default values in prompts
  // -------------------------------------------------------------------------

  describe('default values', () => {
    it('uses directory basename as default project name', async () => {
      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('my-project')
        .mockResolvedValueOnce('acme/app')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('main');

      await runInteractivePrompts({}, GIT_ROOT);

      const projectNameCall = mockText.mock.calls[0]![0] as { initialValue?: string };
      // GIT_ROOT is /home/user/my-project — basename is "my-project"
      expect(projectNameCall.initialValue).toBe('my-project');
    });

    it('uses "main" as default base branch', async () => {
      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('Project')
        .mockResolvedValueOnce('acme/app')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('main');

      await runInteractivePrompts({}, GIT_ROOT);

      const baseBranchCall = mockText.mock.calls[3]![0] as { initialValue?: string };
      expect(baseBranchCall.initialValue).toBe('main');
    });

    it('uses "claude-code" as default agent', async () => {
      mockSelect
        .mockResolvedValueOnce('standard')
        .mockResolvedValueOnce('claude-code');
      mockText
        .mockResolvedValueOnce('Project')
        .mockResolvedValueOnce('acme/app')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('main');

      await runInteractivePrompts({}, GIT_ROOT);

      // Second select call is for agent (first is variant)
      const agentCall = mockSelect.mock.calls[1]![0] as { initialValue?: string };
      expect(agentCall.initialValue).toBe('claude-code');
    });
  });
});
