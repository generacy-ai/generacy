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
  copyFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  rmSync: vi.fn(),
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
const { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } =
  await import('node:fs');
const { setupBuildCommand } = await import('../../cli/commands/setup/build.js');

const mockExecSync = execSync as Mock;
const mockCopyFileSync = copyFileSync as Mock;
const mockExistsSync = existsSync as Mock;
const mockMkdirSync = mkdirSync as Mock;
const mockReadFileSync = readFileSync as Mock;
const mockReaddirSync = readdirSync as Mock;
const mockRmSync = rmSync as Mock;
const mockWriteFileSync = writeFileSync as Mock;

// Track process.exit calls without actually exiting
let mockExit: Mock;

beforeEach(() => {
  vi.resetAllMocks();
  mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never) as unknown as Mock;
});

/**
 * Helper: run the build command action with the given CLI options.
 */
async function runBuildCommand(args: string[] = []) {
  const command = setupBuildCommand();
  await command.parseAsync(['node', 'build', ...args]);
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
          throw new Error(`Command failed: ${cmd}`);
        }
        return behavior.stdout ?? '';
      }
    }
    return '';
  });
}

/**
 * Helper: configure mockExistsSync for build scenarios.
 * @param existingPaths - paths that should return true
 */
function mockFileSystem(existingPaths: string[] = []) {
  mockExistsSync.mockImplementation((path: string) => {
    return existingPaths.includes(path);
  });
}

describe('setup build command', () => {
  describe('skip flags', () => {
    it('--skip-cleanup skips Phase 1 entirely', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/agency',
        '/workspaces/latency',
        '/workspaces/generacy',
        '/workspaces/agency/packages/agency/dist/cli.js',
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
        '/workspaces/generacy/packages/generacy/dist/cli/index.js',
      ]);

      await runBuildCommand(['--skip-cleanup']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Skipping Phase 1: Plugin cleanup (--skip-cleanup)',
      );
      // Phase 1 operations should NOT have been called
      expect(mockRmSync).not.toHaveBeenCalled();
      // Phase 2 and 3 should still run
      expect(mockLogger.info).toHaveBeenCalledWith('Phase 2: Building Agency packages');
      expect(mockLogger.info).toHaveBeenCalledWith('Phase 3: Building Generacy packages');
    });

    it('--skip-agency skips Phase 2 entirely', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/generacy',
        '/workspaces/generacy/packages/generacy/dist/cli/index.js',
      ]);

      await runBuildCommand(['--skip-agency']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Skipping Phase 2: Agency build (--skip-agency)',
      );
      // Agency build commands should NOT have been called
      const execCalls = mockExecSync.mock.calls
        .map((c) => c[0] as string);
      expect(execCalls.some((c) => c.includes('/workspaces/agency'))).toBe(false);
      // Phase 1 and 3 should still run
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Phase 1: Cleaning stale Claude plugin state',
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Phase 3: Building Generacy packages');
    });

    it('--skip-generacy skips Phase 3 entirely', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/agency',
        '/workspaces/latency',
        '/workspaces/agency/packages/agency/dist/cli.js',
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
      ]);

      await runBuildCommand(['--skip-generacy']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Skipping Phase 3: Generacy build (--skip-generacy)',
      );
      // Generacy build commands should NOT have been called
      const execCalls = mockExecSync.mock.calls
        .map((c) => c[0] as string);
      expect(execCalls.some((c) => c.includes('/workspaces/generacy'))).toBe(false);
      // Phase 1 and 2 should still run
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Phase 1: Cleaning stale Claude plugin state',
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Phase 2: Building Agency packages');
    });

    it('all skip flags skip all phases', async () => {
      mockExecBehavior();
      mockFileSystem();

      await runBuildCommand(['--skip-cleanup', '--skip-agency', '--skip-generacy']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Skipping Phase 1: Plugin cleanup (--skip-cleanup)',
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Skipping Phase 2: Agency build (--skip-agency)',
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Skipping Phase 3: Generacy build (--skip-generacy)',
      );
      expect(mockRmSync).not.toHaveBeenCalled();
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  describe('Phase 1: plugin state cleanup', () => {
    it('removes marketplace cache directories via rmSync', async () => {
      mockExecBehavior();
      mockFileSystem();

      await runBuildCommand(['--skip-agency', '--skip-generacy']);

      // Should remove painworth-marketplace cache and marketplace directories
      expect(mockRmSync).toHaveBeenCalledWith(
        '/home/testuser/.claude/plugins/cache/painworth-marketplace',
        { recursive: true, force: true },
      );
      expect(mockRmSync).toHaveBeenCalledWith(
        '/home/testuser/.claude/plugins/marketplaces/painworth-marketplace',
        { recursive: true, force: true },
      );
    });

    it('resets installed_plugins.json to version 2 with empty plugins', async () => {
      mockExecBehavior();
      mockFileSystem();

      await runBuildCommand(['--skip-agency', '--skip-generacy']);

      expect(mockMkdirSync).toHaveBeenCalledWith(
        '/home/testuser/.claude/plugins',
        { recursive: true },
      );
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/home/testuser/.claude/plugins/installed_plugins.json',
        JSON.stringify({ version: 2, plugins: {} }),
      );
    });

    it('removes known_marketplaces.json and install-counts-cache.json', async () => {
      mockExecBehavior();
      mockFileSystem();

      await runBuildCommand(['--skip-agency', '--skip-generacy']);

      expect(mockRmSync).toHaveBeenCalledWith(
        '/home/testuser/.claude/plugins/known_marketplaces.json',
        { force: true },
      );
      expect(mockRmSync).toHaveBeenCalledWith(
        '/home/testuser/.claude/plugins/install-counts-cache.json',
        { force: true },
      );
    });

    it('removes enabledPlugins from settings.json while preserving other keys', async () => {
      const existingSettings = {
        theme: 'dark',
        enabledPlugins: ['plugin-a', 'plugin-b'],
        fontSize: 14,
      };
      mockExecBehavior();
      mockFileSystem(['/home/testuser/.claude/settings.json']);
      mockReadFileSync.mockReturnValue(JSON.stringify(existingSettings));

      await runBuildCommand(['--skip-agency', '--skip-generacy']);

      // Should write settings.json without enabledPlugins
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/home/testuser/.claude/settings.json',
        JSON.stringify({ theme: 'dark', fontSize: 14 }, null, 2),
      );
    });

    it('skips settings.json update when file does not exist', async () => {
      mockExecBehavior();
      mockFileSystem(); // settings.json does not exist

      await runBuildCommand(['--skip-agency', '--skip-generacy']);

      // readFileSync should not be called for settings.json
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });

    it('logs cleanup errors as warnings, not thrown', async () => {
      mockExecBehavior();
      mockFileSystem();
      mockRmSync.mockImplementation(() => {
        throw new Error('permission denied');
      });

      await runBuildCommand(['--skip-agency', '--skip-generacy']);

      // Should warn, not throw
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('permission denied') }),
        expect.stringContaining('Failed to remove'),
      );
      // Command should not exit with error
      expect(mockExit).not.toHaveBeenCalled();
      // Phase 1 should still complete
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Phase 1 complete: Plugin state cleaned',
      );
    });

    it('logs warning when installed_plugins.json reset fails', async () => {
      mockExecBehavior();
      mockFileSystem();
      mockMkdirSync.mockImplementation(() => {
        throw new Error('mkdir failed');
      });

      await runBuildCommand(['--skip-agency', '--skip-generacy']);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('mkdir failed') }),
        'Failed to reset installed_plugins.json',
      );
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('logs warning when settings.json update fails', async () => {
      mockExecBehavior();
      mockFileSystem(['/home/testuser/.claude/settings.json']);
      mockReadFileSync.mockImplementation(() => {
        throw new Error('read failed');
      });

      await runBuildCommand(['--skip-agency', '--skip-generacy']);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('read failed') }),
        'Failed to update settings.json',
      );
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe('Phase 2: agency build', () => {
    it('builds latency before agency (verify call order)', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/agency',
        '/workspaces/latency',
        '/workspaces/agency/packages/agency/dist/cli.js',
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-generacy']);

      const execCalls = mockExecSync.mock.calls.map((c) => c[0] as string);

      // Find latency and agency build command indices
      const latencyInstallIdx = execCalls.findIndex(
        (c) => c.includes('pnpm install') && c.includes('no-frozen-lockfile'),
      );
      const latencyBuildIdx = execCalls.findIndex(
        (c) => c === 'pnpm build' && mockExecSync.mock.calls[execCalls.indexOf(c)]?.[1]?.cwd === '/workspaces/latency',
      );

      // Find latency build by checking cwd
      let latencyBuildCallIdx = -1;
      let agencyInstallCallIdx = -1;
      for (let i = 0; i < mockExecSync.mock.calls.length; i++) {
        const cmd = mockExecSync.mock.calls[i][0] as string;
        const opts = mockExecSync.mock.calls[i][1] as { cwd?: string } | undefined;
        if (cmd === 'pnpm build' && opts?.cwd === '/workspaces/latency') {
          latencyBuildCallIdx = i;
        }
        if (cmd.includes('pnpm install') && opts?.cwd === '/workspaces/agency') {
          agencyInstallCallIdx = i;
        }
      }

      expect(latencyBuildCallIdx).toBeGreaterThanOrEqual(0);
      expect(agencyInstallCallIdx).toBeGreaterThanOrEqual(0);
      expect(latencyBuildCallIdx).toBeLessThan(agencyInstallCallIdx);
    });

    it('installs and builds agency after latency', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/agency',
        '/workspaces/latency',
        '/workspaces/agency/packages/agency/dist/cli.js',
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-generacy']);

      expect(mockExecSync).toHaveBeenCalledWith(
        'pnpm install --no-frozen-lockfile',
        expect.objectContaining({ cwd: '/workspaces/agency' }),
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        'pnpm build',
        expect.objectContaining({ cwd: '/workspaces/agency' }),
      );
    });

    it('skips latency build when latency directory does not exist', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/agency',
        // No /workspaces/latency
        '/workspaces/agency/packages/agency/dist/cli.js',
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-generacy']);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { dir: '/workspaces/latency' },
        'Latency directory not found, skipping',
      );
      // Agency should still be built
      expect(mockExecSync).toHaveBeenCalledWith(
        'pnpm install --no-frozen-lockfile',
        expect.objectContaining({ cwd: '/workspaces/agency' }),
      );
    });

    it('skips Phase 2 entirely when agency directory does not exist', async () => {
      mockExecBehavior();
      mockFileSystem([]); // No agency dir

      await runBuildCommand(['--skip-cleanup', '--skip-generacy']);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { dir: '/workspaces/agency' },
        'Agency directory not found, skipping',
      );
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('creates .agency/config.json when it does not exist', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/agency',
        '/workspaces/latency',
        // .agency/config.json does NOT exist
        '/workspaces/agency/packages/agency/dist/cli.js',
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-generacy']);

      expect(mockLogger.info).toHaveBeenCalledWith('Creating .agency/config.json');
      expect(mockMkdirSync).toHaveBeenCalledWith(
        '/workspaces/agency/.agency',
        { recursive: true },
      );
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/workspaces/agency/.agency/config.json',
        JSON.stringify(
          {
            name: 'agency',
            pluginPaths: ['/workspaces/agency/packages'],
            defaultMode: 'coding',
            modes: { coding: ['*'], research: ['*'], default: ['*'] },
          },
          null,
          2,
        ),
      );
    });

    it('does not create .agency/config.json when it already exists', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/agency',
        '/workspaces/latency',
        '/workspaces/agency/.agency/config.json',
        '/workspaces/agency/packages/agency/dist/cli.js',
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-generacy']);

      expect(mockLogger.debug).toHaveBeenCalledWith('.agency/config.json already exists');
      // writeFileSync should not be called for config.json
      const configWriteCalls = mockWriteFileSync.mock.calls.filter(
        (c) => (c[0] as string).includes('config.json'),
      );
      expect(configWriteCalls).toHaveLength(0);
    });

    it('exits with code 1 when agency CLI artifact is missing', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/agency',
        '/workspaces/latency',
        // Missing: /workspaces/agency/packages/agency/dist/cli.js
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-generacy']);

      expect(mockLogger.error).toHaveBeenCalledWith(
        { path: '/workspaces/agency/packages/agency/dist/cli.js' },
        'Agency CLI artifact missing after build',
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('exits with code 1 when spec-kit plugin artifact is missing', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/agency',
        '/workspaces/latency',
        '/workspaces/agency/packages/agency/dist/cli.js',
        // Missing: /workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-generacy']);

      expect(mockLogger.error).toHaveBeenCalledWith(
        { path: '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js' },
        'Spec-kit plugin artifact missing after build',
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe('Phase 3: generacy build', () => {
    it('installs with --filter excluding claude-code plugin', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/generacy',
        '/workspaces/generacy/packages/generacy/dist/cli/index.js',
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-agency']);

      expect(mockExecSync).toHaveBeenCalledWith(
        'pnpm install --filter "!@generacy-ai/generacy-plugin-claude-code"',
        expect.objectContaining({ cwd: '/workspaces/generacy' }),
      );
    });

    it('builds generacy after installing', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/generacy',
        '/workspaces/generacy/packages/generacy/dist/cli/index.js',
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-agency']);

      expect(mockExecSync).toHaveBeenCalledWith(
        'pnpm build',
        expect.objectContaining({ cwd: '/workspaces/generacy' }),
      );
    });

    it('runs npm link in packages/generacy directory', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/generacy',
        '/workspaces/generacy/packages/generacy/dist/cli/index.js',
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-agency']);

      expect(mockExecSync).toHaveBeenCalledWith(
        'npm link',
        expect.objectContaining({ cwd: '/workspaces/generacy/packages/generacy' }),
      );
    });

    it('skips Phase 3 when generacy directory does not exist', async () => {
      mockExecBehavior();
      mockFileSystem([]); // No generacy dir

      await runBuildCommand(['--skip-cleanup', '--skip-agency']);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { dir: '/workspaces/generacy' },
        'Generacy directory not found, skipping',
      );
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('exits with code 1 when generacy CLI artifact is missing', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/generacy',
        // Missing: /workspaces/generacy/packages/generacy/dist/cli/index.js
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-agency']);

      expect(mockLogger.error).toHaveBeenCalledWith(
        { path: '/workspaces/generacy/packages/generacy/dist/cli/index.js' },
        'Generacy CLI artifact missing after build',
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe('Phase 4: marketplace plugin install', () => {
    it('registers marketplace in ~/.claude/settings.json with version pinning', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/agency',
        '/workspaces/latency',
        '/workspaces/agency/packages/agency/dist/cli.js',
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-generacy']);

      // Should write settings.json with marketplace registration
      const settingsCalls = mockWriteFileSync.mock.calls.filter(
        (c) => (c[0] as string) === '/home/testuser/.claude/settings.json',
      );
      expect(settingsCalls.length).toBeGreaterThan(0);
      const written = JSON.parse(settingsCalls[0][1] as string);
      expect(written.extraKnownMarketplaces['generacy-marketplace']).toEqual({
        source: {
          source: 'github',
          repo: 'generacy-ai/agency',
          ref: 'v1.0.0',
        },
      });
    });

    it('registers marketplace without ref when --latest is passed', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/agency',
        '/workspaces/latency',
        '/workspaces/agency/packages/agency/dist/cli.js',
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-generacy', '--latest']);

      const settingsCalls = mockWriteFileSync.mock.calls.filter(
        (c) => (c[0] as string) === '/home/testuser/.claude/settings.json',
      );
      expect(settingsCalls.length).toBeGreaterThan(0);
      const written = JSON.parse(settingsCalls[0][1] as string);
      expect(written.extraKnownMarketplaces['generacy-marketplace']).toEqual({
        source: {
          source: 'github',
          repo: 'generacy-ai/agency',
        },
      });
    });

    it('preserves existing settings when registering marketplace', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/home/testuser/.claude/settings.json',
        '/workspaces/agency',
        '/workspaces/latency',
        '/workspaces/agency/packages/agency/dist/cli.js',
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
      ]);
      mockReadFileSync.mockReturnValue(JSON.stringify({ theme: 'dark', fontSize: 14 }));

      await runBuildCommand(['--skip-cleanup', '--skip-generacy']);

      const settingsCalls = mockWriteFileSync.mock.calls.filter(
        (c) => (c[0] as string) === '/home/testuser/.claude/settings.json',
      );
      const written = JSON.parse(settingsCalls[0][1] as string);
      expect(written.theme).toBe('dark');
      expect(written.fontSize).toBe(14);
      expect(written.extraKnownMarketplaces['generacy-marketplace']).toBeDefined();
    });

    it('runs claude plugin install command', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/agency',
        '/workspaces/latency',
        '/workspaces/agency/packages/agency/dist/cli.js',
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-generacy']);

      // execSync should have been called with the plugin install command
      expect(mockExecSync).toHaveBeenCalledWith(
        'claude plugin install agency-spec-kit@generacy-marketplace --scope user',
        expect.anything(),
      );
    });

    it('falls back to file copy when marketplace install fails', async () => {
      mockExecBehavior({
        'claude plugin install': { throw: true },
      });
      mockFileSystem([
        '/workspaces/agency',
        '/workspaces/latency',
        '/workspaces/agency/packages/agency/dist/cli.js',
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
        '/workspaces/agency/packages/claude-plugin-agency-spec-kit/commands',
      ]);
      mockReaddirSync.mockReturnValue(['specify.md', 'clarify.md', 'plan.md']);

      await runBuildCommand(['--skip-cleanup', '--skip-generacy']);

      // Should warn about marketplace failure
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ stderr: expect.any(String) }),
        'Marketplace plugin install failed, trying fallback',
      );
      // Should copy files as fallback
      expect(mockCopyFileSync).toHaveBeenCalledTimes(3);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ count: 3 }),
        'Fallback: copied speckit command definitions',
      );
    });

    it('warns when both marketplace and fallback fail', async () => {
      mockExecBehavior({
        'claude plugin install': { throw: true },
      });
      mockFileSystem([
        '/workspaces/agency',
        '/workspaces/latency',
        '/workspaces/agency/packages/agency/dist/cli.js',
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
        // No commands directory — fallback also fails
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-generacy']);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          dir: '/workspaces/agency/packages/claude-plugin-agency-spec-kit/commands',
        }),
        'Speckit commands directory not found and marketplace install failed',
      );
    });

    it('cleans up old file-copy commands when plugin installs successfully', async () => {
      mockExecBehavior();
      // Make some old command files exist
      mockFileSystem([
        '/workspaces/agency',
        '/workspaces/latency',
        '/workspaces/agency/packages/agency/dist/cli.js',
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
        '/home/testuser/.claude/commands/specify.md',
        '/home/testuser/.claude/commands/clarify.md',
        '/home/testuser/.claude/commands/plan.md',
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-generacy']);

      // Should remove old command files
      expect(mockRmSync).toHaveBeenCalledWith(
        '/home/testuser/.claude/commands/specify.md',
        { force: true },
      );
      expect(mockRmSync).toHaveBeenCalledWith(
        '/home/testuser/.claude/commands/clarify.md',
        { force: true },
      );
      expect(mockRmSync).toHaveBeenCalledWith(
        '/home/testuser/.claude/commands/plan.md',
        { force: true },
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        { count: 3 },
        'Cleaned up old file-copy commands',
      );
    });

    it('configures Agency MCP server in ~/.claude.json', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/agency',
        '/workspaces/latency',
        '/workspaces/agency/packages/agency/dist/cli.js',
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-generacy']);

      const claudeJsonCalls = mockWriteFileSync.mock.calls.filter(
        (c) => (c[0] as string) === '/home/testuser/.claude.json',
      );
      expect(claudeJsonCalls.length).toBeGreaterThan(0);
      const written = JSON.parse(claudeJsonCalls[0][1] as string);
      expect(written.mcpServers.agency).toEqual({
        type: 'stdio',
        command: 'node',
        args: ['/workspaces/agency/packages/agency/dist/cli.js'],
        cwd: '/workspaces/agency',
      });
    });

    it('skips MCP configuration when Agency CLI not found', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/agency',
        '/workspaces/latency',
        // Agency CLI missing
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
      ]);

      // Note: buildAgency would normally exit(1) here, but we mock exit
      await runBuildCommand(['--skip-cleanup', '--skip-generacy']);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Agency CLI not found, skipping MCP configuration',
      );
    });
  });

  describe('logging', () => {
    it('logs initial build process message', async () => {
      mockExecBehavior();
      mockFileSystem();

      await runBuildCommand(['--skip-cleanup', '--skip-agency', '--skip-generacy']);

      expect(mockLogger.info).toHaveBeenCalledWith('Starting build process');
    });

    it('logs build process complete message', async () => {
      mockExecBehavior();
      mockFileSystem();

      await runBuildCommand(['--skip-cleanup', '--skip-agency', '--skip-generacy']);

      expect(mockLogger.info).toHaveBeenCalledWith('Build process complete');
    });

    it('logs Phase 2 completion on success', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/agency',
        '/workspaces/latency',
        '/workspaces/agency/packages/agency/dist/cli.js',
        '/workspaces/agency/packages/agency-plugin-spec-kit/dist/index.js',
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-generacy']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Phase 2 complete: Agency built and verified',
      );
    });

    it('logs Phase 3 completion on success', async () => {
      mockExecBehavior();
      mockFileSystem([
        '/workspaces/generacy',
        '/workspaces/generacy/packages/generacy/dist/cli/index.js',
      ]);

      await runBuildCommand(['--skip-cleanup', '--skip-agency']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Phase 3 complete: Generacy built and verified',
      );
    });
  });
});
