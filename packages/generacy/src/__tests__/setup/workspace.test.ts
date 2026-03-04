import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// Stable mock logger instance — same object returned by every getLogger() call
const mockLogger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

// Mock child_process before importing the module under test
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// Mock fs
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Mock os.homedir
vi.mock('node:os', () => ({
  homedir: () => '/home/testuser',
}));

// Mock the logger — return the same stable instance every time
vi.mock('../../cli/utils/logger.js', () => ({
  getLogger: () => mockLogger,
}));

// Import after mocks are set up
const { execSync } = await import('node:child_process');
const { existsSync } = await import('node:fs');
const { setupWorkspaceCommand } = await import('../../cli/commands/setup/workspace.js');

const mockExecSync = execSync as Mock;
const mockExistsSync = existsSync as Mock;

// Track process.exit calls without actually exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

// Saved env state
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  vi.clearAllMocks();
  savedEnv = { ...process.env };
  // Clear relevant env vars
  delete process.env['REPOS'];
  delete process.env['REPO_BRANCH'];
  delete process.env['DEFAULT_BRANCH'];
  delete process.env['CLEAN_REPOS'];
  delete process.env['GITHUB_ORG'];
  delete process.env['GH_TOKEN'];
  delete process.env['GH_USERNAME'];
});

afterEach(() => {
  process.env = savedEnv;
});

/**
 * Helper: run the workspace command action with the given CLI options.
 */
async function runWorkspaceCommand(args: string[] = []) {
  const command = setupWorkspaceCommand();
  await command.parseAsync(['node', 'workspace', ...args]);
}

/**
 * Helper: configure mockExecSync to handle specific commands.
 * By default all commands succeed and return empty string.
 */
function mockExecBehavior(overrides: Record<string, { throw?: boolean; stdout?: string }> = {}) {
  mockExecSync.mockImplementation((cmd: string) => {
    for (const [pattern, behavior] of Object.entries(overrides)) {
      if (cmd.includes(pattern)) {
        if (behavior.throw) {
          const error = Object.assign(new Error(`Command failed: ${cmd}`), {
            stdout: '',
            stderr: `error running: ${cmd}`,
          });
          throw error;
        }
        return behavior.stdout ?? '';
      }
    }
    return '';
  });
}

/**
 * Helper: configure mockExistsSync for workspace scenarios.
 * @param existingRepos - repo names that have a .git directory (update path)
 * @param extraPaths - additional paths that should return true (e.g. pnpm-lock.yaml, package.json)
 */
function mockFileSystem(
  existingRepos: string[] = [],
  extraPaths: string[] = [],
) {
  mockExistsSync.mockImplementation((path: string) => {
    // Check for .git directories (existing repos)
    for (const repo of existingRepos) {
      if (path === `/workspaces/${repo}/.git`) return true;
    }
    // Check for extra paths (package.json, lock files, credentials)
    for (const extra of extraPaths) {
      if (path === extra || path.endsWith(extra)) return true;
    }
    return false;
  });
}

describe('setup workspace command', () => {
  describe('config resolution', () => {
    it('bootstraps with tetrad-development when no CLI args, env vars, or config file', async () => {
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand([]);

      // Should bootstrap by cloning only tetrad-development (config file not found)
      const cloneCalls = mockExecSync.mock.calls
        .map((c) => c[0] as string)
        .filter((cmd) => cmd.includes('git clone'));
      expect(cloneCalls).toHaveLength(1);
      expect(cloneCalls.some((c) => c.includes('tetrad-development'))).toBe(true);
    });

    it('uses REPOS env var override (comma-separated → array)', async () => {
      process.env['REPOS'] = 'repo-a, repo-b, repo-c';
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand([]);

      const cloneCalls = mockExecSync.mock.calls
        .map((c) => c[0] as string)
        .filter((cmd) => cmd.includes('git clone'));
      expect(cloneCalls).toHaveLength(3);
      expect(cloneCalls.some((c) => c.includes('repo-a'))).toBe(true);
      expect(cloneCalls.some((c) => c.includes('repo-b'))).toBe(true);
      expect(cloneCalls.some((c) => c.includes('repo-c'))).toBe(true);
    });

    it('filters empty entries from REPOS env var', async () => {
      process.env['REPOS'] = 'repo-a,,repo-b, ,repo-c';
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand([]);

      const cloneCalls = mockExecSync.mock.calls
        .map((c) => c[0] as string)
        .filter((cmd) => cmd.includes('git clone'));
      expect(cloneCalls).toHaveLength(3);
    });

    it('CLI --repos overrides REPOS env var', async () => {
      process.env['REPOS'] = 'env-repo';
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'cli-repo-a,cli-repo-b']);

      const cloneCalls = mockExecSync.mock.calls
        .map((c) => c[0] as string)
        .filter((cmd) => cmd.includes('git clone'));
      expect(cloneCalls).toHaveLength(2);
      expect(cloneCalls.some((c) => c.includes('cli-repo-a'))).toBe(true);
      expect(cloneCalls.some((c) => c.includes('cli-repo-b'))).toBe(true);
      expect(cloneCalls.some((c) => c.includes('env-repo'))).toBe(false);
    });

    it('uses default branch "develop" when no env vars or CLI args', async () => {
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'test-repo']);

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git clone --branch develop'),
        expect.any(Object),
      );
    });

    it('REPO_BRANCH env var overrides default branch', async () => {
      process.env['REPO_BRANCH'] = 'feature-branch';
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'test-repo']);

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git clone --branch feature-branch'),
        expect.any(Object),
      );
    });

    it('REPO_BRANCH takes precedence over DEFAULT_BRANCH', async () => {
      process.env['REPO_BRANCH'] = 'repo-branch';
      process.env['DEFAULT_BRANCH'] = 'default-branch';
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'test-repo']);

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git clone --branch repo-branch'),
        expect.any(Object),
      );
    });

    it('DEFAULT_BRANCH used when REPO_BRANCH not set', async () => {
      process.env['DEFAULT_BRANCH'] = 'main';
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'test-repo']);

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git clone --branch main'),
        expect.any(Object),
      );
    });

    it('CLI --branch overrides all env vars', async () => {
      process.env['REPO_BRANCH'] = 'env-branch';
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'test-repo', '--branch', 'cli-branch']);

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git clone --branch cli-branch'),
        expect.any(Object),
      );
    });

    it('CLEAN_REPOS env var parsed as boolean', async () => {
      process.env['CLEAN_REPOS'] = 'true';
      mockExecBehavior();
      mockFileSystem(['test-repo']);

      await runWorkspaceCommand(['--repos', 'test-repo']);

      expect(mockExecSync).toHaveBeenCalledWith(
        'git reset --hard HEAD',
        expect.objectContaining({ cwd: '/workspaces/test-repo' }),
      );
    });

    it('CLEAN_REPOS env var not triggered when value is not "true"', async () => {
      process.env['CLEAN_REPOS'] = 'false';
      mockExecBehavior();
      mockFileSystem(['test-repo']);

      await runWorkspaceCommand(['--repos', 'test-repo']);

      const resetCalls = mockExecSync.mock.calls
        .map((c) => c[0] as string)
        .filter((cmd) => cmd.includes('git reset --hard'));
      expect(resetCalls).toHaveLength(0);
    });

    it('GITHUB_ORG env var used in clone URL', async () => {
      process.env['GITHUB_ORG'] = 'my-org';
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'test-repo']);

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('https://github.com/my-org/test-repo.git'),
        expect.any(Object),
      );
    });

    it('defaults to generacy-ai org when GITHUB_ORG not set', async () => {
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'test-repo']);

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('https://github.com/generacy-ai/test-repo.git'),
        expect.any(Object),
      );
    });
  });

  describe('repo ordering', () => {
    it('processes tetrad-development first regardless of list order', async () => {
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'agency,tetrad-development,latency']);

      const cloneCalls = mockExecSync.mock.calls
        .map((c) => c[0] as string)
        .filter((cmd) => cmd.includes('git clone'));

      const tetradIdx = cloneCalls.findIndex((c) => c.includes('/tetrad-development.git'));
      const agencyIdx = cloneCalls.findIndex((c) => c.includes('/agency.git'));
      const latencyIdx = cloneCalls.findIndex((c) => c.includes('/latency.git'));

      expect(tetradIdx).toBeGreaterThanOrEqual(0);
      expect(agencyIdx).toBeGreaterThanOrEqual(0);
      expect(tetradIdx).toBeLessThan(agencyIdx);
      expect(tetradIdx).toBeLessThan(latencyIdx);
    });

    it('does not duplicate tetrad-development when already first', async () => {
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'tetrad-development,agency']);

      const cloneCalls = mockExecSync.mock.calls
        .map((c) => c[0] as string)
        .filter((cmd) => cmd.includes('git clone') && cmd.includes('tetrad-development'));
      expect(cloneCalls).toHaveLength(1);
    });
  });

  describe('clone path (new repos)', () => {
    it('clones repo with --branch flag for non-existing repos', async () => {
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'new-repo', '--branch', 'main']);

      expect(mockExecSync).toHaveBeenCalledWith(
        'git clone --branch main https://github.com/generacy-ai/new-repo.git /workspaces/new-repo',
        expect.any(Object),
      );
    });

    it('logs successful clone', async () => {
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'new-repo']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { repo: 'new-repo', branch: 'develop' },
        'Cloning repository',
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        { repo: 'new-repo' },
        'Repository cloned successfully',
      );
    });

    it('falls back to clone without branch when branch clone fails', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git clone --branch')) {
          const error = Object.assign(new Error('branch not found'), {
            stdout: '',
            stderr: 'Remote branch not found',
          });
          throw error;
        }
        return '';
      });
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'new-repo']);

      // Should try clone without branch
      expect(mockExecSync).toHaveBeenCalledWith(
        'git clone https://github.com/generacy-ai/new-repo.git /workspaces/new-repo',
        expect.any(Object),
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        { repo: 'new-repo' },
        'Branch not found, cloning default branch',
      );
    });

    it('logs error when both clone attempts fail', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git clone')) {
          const error = Object.assign(new Error('clone failed'), {
            stdout: '',
            stderr: 'fatal: repo not found',
          });
          throw error;
        }
        return '';
      });
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'missing-repo']);

      expect(mockLogger.error).toHaveBeenCalledWith(
        { repo: 'missing-repo', stderr: 'fatal: repo not found' },
        'Failed to clone repository',
      );
    });
  });

  describe('update path (existing repos)', () => {
    it('fetches and pulls for repos with existing .git directory', async () => {
      mockExecBehavior();
      mockFileSystem(['existing-repo']);

      await runWorkspaceCommand(['--repos', 'existing-repo']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { repo: 'existing-repo' },
        'Repository exists, updating',
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        'git fetch origin',
        expect.objectContaining({ cwd: '/workspaces/existing-repo' }),
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        'git pull origin develop',
        expect.objectContaining({ cwd: '/workspaces/existing-repo' }),
      );
    });

    it('switches branch when current branch differs from target', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git branch --show-current')) {
          return 'old-branch';
        }
        return '';
      });
      mockFileSystem(['existing-repo']);

      await runWorkspaceCommand(['--repos', 'existing-repo', '--branch', 'new-branch']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { repo: 'existing-repo', from: 'old-branch', to: 'new-branch' },
        'Switching branch',
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        'git checkout new-branch',
        expect.objectContaining({ cwd: '/workspaces/existing-repo' }),
      );
    });

    it('creates tracking branch when checkout fails', async () => {
      let checkoutAttempt = 0;
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git branch --show-current')) {
          return 'old-branch';
        }
        if (cmd === 'git checkout target-branch') {
          checkoutAttempt++;
          const error = Object.assign(new Error('branch not found'), {
            stdout: '',
            stderr: 'error: pathspec not found',
          });
          throw error;
        }
        return '';
      });
      mockFileSystem(['existing-repo']);

      await runWorkspaceCommand(['--repos', 'existing-repo', '--branch', 'target-branch']);

      expect(mockExecSync).toHaveBeenCalledWith(
        'git checkout -b target-branch origin/target-branch',
        expect.objectContaining({ cwd: '/workspaces/existing-repo' }),
      );
    });
  });

  describe('--clean flag', () => {
    it('runs git reset --hard HEAD and git clean -fd before updating', async () => {
      mockExecBehavior();
      mockFileSystem(['dirty-repo']);

      await runWorkspaceCommand(['--repos', 'dirty-repo', '--clean']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { repo: 'dirty-repo' },
        'Cleaning repository (--clean)',
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        'git reset --hard HEAD',
        expect.objectContaining({ cwd: '/workspaces/dirty-repo' }),
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        'git clean -fd',
        expect.objectContaining({ cwd: '/workspaces/dirty-repo' }),
      );
    });

    it('does not run clean commands when --clean is not set', async () => {
      mockExecBehavior();
      mockFileSystem(['existing-repo']);

      await runWorkspaceCommand(['--repos', 'existing-repo']);

      const resetCalls = mockExecSync.mock.calls
        .map((c) => c[0] as string)
        .filter((cmd) => cmd.includes('git reset --hard'));
      expect(resetCalls).toHaveLength(0);
    });
  });

  describe('detectPackageManager', () => {
    it('uses pnpm when pnpm-lock.yaml exists', async () => {
      mockExecBehavior();
      mockFileSystem([], [
        '/workspaces/pnpm-repo/package.json',
        '/workspaces/pnpm-repo/pnpm-lock.yaml',
      ]);

      // Repo clones successfully, then install checks package.json + lock file
      await runWorkspaceCommand(['--repos', 'pnpm-repo']);

      expect(mockExecSync).toHaveBeenCalledWith(
        'pnpm install',
        expect.objectContaining({ cwd: '/workspaces/pnpm-repo' }),
      );
    });

    it('uses npm when pnpm-lock.yaml does not exist', async () => {
      mockExecBehavior();
      mockFileSystem([], [
        '/workspaces/npm-repo/package.json',
      ]);

      await runWorkspaceCommand(['--repos', 'npm-repo']);

      expect(mockExecSync).toHaveBeenCalledWith(
        'npm install',
        expect.objectContaining({ cwd: '/workspaces/npm-repo' }),
      );
    });
  });

  describe('dependency installation', () => {
    it('skips install when no package.json exists', async () => {
      mockExecBehavior();
      mockFileSystem(); // No extra paths → no package.json

      await runWorkspaceCommand(['--repos', 'no-pkg-repo']);

      const installCalls = mockExecSync.mock.calls
        .map((c) => c[0] as string)
        .filter((cmd) => cmd.includes('install') && !cmd.includes('git'));
      expect(installCalls).toHaveLength(0);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { repo: 'no-pkg-repo' },
        'No package.json, skipping dependency install',
      );
    });

    it('logs warning and continues when install fails', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('pnpm install') || cmd.includes('npm install')) {
          const error = Object.assign(new Error('install failed'), {
            stdout: '',
            stderr: 'ERR! install failed',
          });
          throw error;
        }
        return '';
      });
      mockFileSystem([], ['/workspaces/failing-repo/package.json']);

      await runWorkspaceCommand(['--repos', 'failing-repo']);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ repo: 'failing-repo' }),
        'Dependency install failed — continuing',
      );
      // Should not exit — install failures are non-fatal
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('only installs deps for successfully cloned repos', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        // Fail clone for bad-repo
        if (cmd.includes('git clone') && cmd.includes('bad-repo')) {
          const error = Object.assign(new Error('clone failed'), {
            stdout: '',
            stderr: 'fatal: not found',
          });
          throw error;
        }
        return '';
      });
      mockFileSystem([], [
        '/workspaces/good-repo/package.json',
        '/workspaces/bad-repo/package.json',
      ]);

      await runWorkspaceCommand(['--repos', 'good-repo,bad-repo']);

      // Only good-repo should have install called
      const installCalls = mockExecSync.mock.calls
        .map((c) => c[0] as string)
        .filter((cmd) => cmd.includes('install') && !cmd.includes('git'));
      expect(installCalls).toHaveLength(1);
      expect(installCalls[0]).toContain('install');
    });
  });

  describe('workspace setup', () => {
    it('creates workdir with mkdirSync', async () => {
      const { mkdirSync } = await import('node:fs');
      const mockMkdirSync = mkdirSync as Mock;
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'test-repo']);

      expect(mockMkdirSync).toHaveBeenCalledWith('/workspaces', { recursive: true });
    });

    it('configures git safe directory', async () => {
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'test-repo']);

      expect(mockExecSync).toHaveBeenCalledWith(
        "git config --global --add safe.directory '*'",
        expect.any(Object),
      );
    });

    it('uses custom --workdir', async () => {
      const { mkdirSync } = await import('node:fs');
      const mockMkdirSync = mkdirSync as Mock;
      mockExecBehavior();
      mockFileSystem();

      // Override existsSync to handle custom workdir
      mockExistsSync.mockImplementation((path: string) => {
        if (path === '/custom/dir/test-repo/package.json') return true;
        return false;
      });

      await runWorkspaceCommand(['--repos', 'test-repo', '--workdir', '/custom/dir']);

      expect(mockMkdirSync).toHaveBeenCalledWith('/custom/dir', { recursive: true });
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('/custom/dir/test-repo'),
        expect.any(Object),
      );
    });
  });

  describe('git credentials', () => {
    it('uses gh auth setup-git when gh CLI is authenticated', async () => {
      mockExecBehavior(); // gh auth status succeeds by default
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'test-repo']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'gh CLI is authenticated, configuring git to use gh credentials',
      );
    });

    it('configures git credentials from GH_TOKEN when gh not authenticated', async () => {
      const { writeFileSync } = await import('node:fs');
      const mockWriteFileSync = writeFileSync as Mock;
      process.env['GH_TOKEN'] = 'ghp_testtoken';
      process.env['GH_USERNAME'] = 'testuser';

      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'gh auth status') {
          const error = Object.assign(new Error('not logged in'), {
            stdout: '',
            stderr: 'not authenticated',
          });
          throw error;
        }
        return '';
      });
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'test-repo']);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/home/testuser/.git-credentials',
        'https://testuser:ghp_testtoken@github.com\n',
        { mode: 0o600 },
      );
    });

    it('warns when no credentials are available', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'gh auth status') {
          const error = Object.assign(new Error('not logged in'), {
            stdout: '',
            stderr: 'not authenticated',
          });
          throw error;
        }
        return '';
      });
      // No GH_TOKEN, no .git-credentials
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'test-repo']);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'No credentials available — relying on credential forwarding',
      );
    });
  });

  describe('summary and exit code', () => {
    it('logs success summary when all repos succeed', async () => {
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'repo-a,repo-b']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { success: 2, failed: 0, total: 2 },
        'Workspace setup complete',
      );
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('exits with code 1 when any repo fails', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git clone') && cmd.includes('bad-repo')) {
          const error = Object.assign(new Error('clone failed'), {
            stdout: '',
            stderr: 'fatal: not found',
          });
          throw error;
        }
        return '';
      });
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'good-repo,bad-repo']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { success: 1, failed: 1, total: 2 },
        'Workspace setup complete',
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        { failures: 1 },
        'Some repos failed to clone — re-run `generacy setup workspace` to retry',
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('reports correct counts with mixed successes and failures', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git clone') && cmd.includes('fail-')) {
          const error = Object.assign(new Error('clone failed'), {
            stdout: '',
            stderr: 'fatal: not found',
          });
          throw error;
        }
        return '';
      });
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'ok-repo,fail-a,fail-b']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { success: 1, failed: 2, total: 3 },
        'Workspace setup complete',
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe('logging', () => {
    it('logs initial setup message', async () => {
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'test-repo']);

      expect(mockLogger.info).toHaveBeenCalledWith('Setting up workspace');
    });

    it('logs configuration summary', async () => {
      mockExecBehavior();
      mockFileSystem();

      await runWorkspaceCommand(['--repos', 'repo-a,repo-b', '--branch', 'main']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { org: 'generacy-ai', branch: 'main', repos: 2, source: 'CLI flag' },
        'Configuration',
      );
    });
  });
});
