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
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
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
const { writeFileSync, mkdirSync } = await import('node:fs');
const { setupAuthCommand } = await import('../../cli/commands/setup/auth.js');

const mockExecSync = execSync as Mock;
const mockWriteFileSync = writeFileSync as Mock;
const mockMkdirSync = mkdirSync as Mock;

// Track process.exit calls without actually exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

// Saved env state
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  vi.clearAllMocks();
  savedEnv = { ...process.env };
  // Clear relevant env vars
  delete process.env['GH_EMAIL'];
  delete process.env['GH_USERNAME'];
  delete process.env['GH_TOKEN'];
});

afterEach(() => {
  process.env = savedEnv;
});

/**
 * Helper: run the auth command action with the given CLI options.
 * Commander parses options and passes them to the action handler,
 * so we simulate this by calling parseAsync with the right argv.
 */
async function runAuthCommand(args: string[] = []) {
  const command = setupAuthCommand();
  await command.parseAsync(['node', 'auth', ...args]);
}

/**
 * Helper: configure mockExecSync to handle specific commands.
 * By default: exec calls succeed, execSafe calls succeed.
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

describe('setup auth command', () => {
  describe('config resolution', () => {
    it('resolves email and username from CLI args', async () => {
      mockExecBehavior();

      await runAuthCommand(['--email', 'test@example.com', '--username', 'testuser']);

      expect(mockExecSync).toHaveBeenCalledWith(
        'git config --global user.name "testuser"',
        expect.any(Object),
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        'git config --global user.email "test@example.com"',
        expect.any(Object),
      );
    });

    it('resolves email and username from env vars when no CLI args', async () => {
      process.env['GH_EMAIL'] = 'env@example.com';
      process.env['GH_USERNAME'] = 'envuser';
      mockExecBehavior();

      await runAuthCommand([]);

      expect(mockExecSync).toHaveBeenCalledWith(
        'git config --global user.name "envuser"',
        expect.any(Object),
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        'git config --global user.email "env@example.com"',
        expect.any(Object),
      );
    });

    it('CLI args override env vars', async () => {
      process.env['GH_EMAIL'] = 'env@example.com';
      process.env['GH_USERNAME'] = 'envuser';
      mockExecBehavior();

      await runAuthCommand(['--email', 'cli@example.com', '--username', 'cliuser']);

      expect(mockExecSync).toHaveBeenCalledWith(
        'git config --global user.name "cliuser"',
        expect.any(Object),
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        'git config --global user.email "cli@example.com"',
        expect.any(Object),
      );
    });

    it('resolves token from GH_TOKEN env var', async () => {
      process.env['GH_TOKEN'] = 'ghp_testtoken123';
      process.env['GH_USERNAME'] = 'tokenuser';
      mockExecBehavior();

      await runAuthCommand([]);

      // Token should trigger credential file write
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/home/testuser/.git-credentials',
        'https://tokenuser:ghp_testtoken123@github.com\n',
        { mode: 0o600 },
      );
    });
  });

  describe('Step 1: git identity configuration', () => {
    it('configures both user.name and user.email when both provided', async () => {
      mockExecBehavior();

      await runAuthCommand(['--email', 'dev@test.com', '--username', 'dev']);

      expect(mockExecSync).toHaveBeenCalledWith(
        'git config --global user.name "dev"',
        expect.any(Object),
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        'git config --global user.email "dev@test.com"',
        expect.any(Object),
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        { username: 'dev', email: 'dev@test.com' },
        'Git user configured',
      );
    });

    it('configures only user.name when email is missing', async () => {
      mockExecBehavior();

      await runAuthCommand(['--username', 'dev']);

      expect(mockExecSync).toHaveBeenCalledWith(
        'git config --global user.name "dev"',
        expect.any(Object),
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        { username: 'dev' },
        'Git user.name configured',
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'GH_EMAIL not set — git user.email not configured',
      );
    });

    it('configures only user.email when username is missing', async () => {
      mockExecBehavior();

      await runAuthCommand(['--email', 'dev@test.com']);

      expect(mockExecSync).toHaveBeenCalledWith(
        'git config --global user.email "dev@test.com"',
        expect.any(Object),
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        { email: 'dev@test.com' },
        'Git user.email configured',
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'GH_USERNAME not set — git user.name not configured',
      );
    });

    it('logs warnings for both missing email and username', async () => {
      mockExecBehavior();

      await runAuthCommand([]);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'GH_USERNAME not set — git user.name not configured',
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'GH_EMAIL not set — git user.email not configured',
      );
    });
  });

  describe('Step 2: git credential helper', () => {
    it('writes ~/.git-credentials with correct content and mode 0o600 when token is set', async () => {
      process.env['GH_TOKEN'] = 'ghp_abc123';
      process.env['GH_USERNAME'] = 'myuser';
      mockExecBehavior();

      await runAuthCommand([]);

      expect(mockExecSync).toHaveBeenCalledWith(
        'git config --global credential.helper store',
        expect.any(Object),
      );
      expect(mockMkdirSync).toHaveBeenCalledWith('/home/testuser', { recursive: true });
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/home/testuser/.git-credentials',
        'https://myuser:ghp_abc123@github.com\n',
        { mode: 0o600 },
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Git credentials configured for github.com',
      );
    });

    it('uses "git" as fallback username in credentials when username not set', async () => {
      process.env['GH_TOKEN'] = 'ghp_abc123';
      mockExecBehavior();

      await runAuthCommand([]);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/home/testuser/.git-credentials',
        'https://git:ghp_abc123@github.com\n',
        { mode: 0o600 },
      );
    });

    it('skips credential file when GH_TOKEN is not set', async () => {
      mockExecBehavior();

      await runAuthCommand(['--username', 'dev', '--email', 'dev@test.com']);

      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'GH_TOKEN not set — git push/pull to private repos will require manual authentication',
      );
    });
  });

  describe('Step 3: gh CLI auth', () => {
    it('skips login when gh auth status already succeeds (with token)', async () => {
      process.env['GH_TOKEN'] = 'ghp_abc123';
      mockExecBehavior(); // all commands succeed

      await runAuthCommand([]);

      // gh auth status is called but gh auth login is NOT called
      expect(mockLogger.info).toHaveBeenCalledWith(
        'GitHub CLI authenticated via GH_TOKEN env var',
      );
    });

    it('pipes token to gh auth login when not authenticated (with token)', async () => {
      process.env['GH_TOKEN'] = 'ghp_abc123';
      let ghAuthStatusCallCount = 0;
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'gh auth status') {
          ghAuthStatusCallCount++;
          // First call (Step 3 check): fail — triggers login
          // Second call (Step 4 verify): succeed
          if (ghAuthStatusCallCount === 1) {
            throw new Error('not logged in');
          }
          return 'Logged in';
        }
        return '';
      });

      await runAuthCommand([]);

      // Should attempt login with token
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('gh auth login --with-token'),
        expect.any(Object),
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'GitHub CLI authenticated via GH_TOKEN',
      );
    });

    it('logs error when gh auth login fails (with token)', async () => {
      process.env['GH_TOKEN'] = 'ghp_abc123';
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'gh auth status') {
          throw new Error('not logged in');
        }
        if (cmd.includes('gh auth login')) {
          const error = Object.assign(new Error('login failed'), {
            stdout: '',
            stderr: 'authentication error',
          });
          throw error;
        }
        return '';
      });

      await runAuthCommand([]);

      expect(mockLogger.error).toHaveBeenCalledWith(
        { stderr: 'authentication error' },
        'Failed to authenticate GitHub CLI',
      );
    });

    it('checks and logs gh auth status when no token', async () => {
      mockExecBehavior(); // gh auth status succeeds

      await runAuthCommand([]);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'GitHub CLI is authenticated',
      );
    });

    it('warns when gh is not authenticated and no token', async () => {
      let ghAuthStatusCallCount = 0;
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'gh auth status') {
          ghAuthStatusCallCount++;
          // First call (Step 3): fail
          // Second call (Step 4 verify): also fail
          throw new Error('not logged in');
        }
        return '';
      });

      await runAuthCommand([]);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'GitHub CLI is not authenticated — set GH_TOKEN in agent.env or run: gh auth login',
      );
    });
  });

  describe('Step 4: verification', () => {
    it('logs success when final gh auth status succeeds', async () => {
      mockExecBehavior();

      await runAuthCommand(['--username', 'dev', '--email', 'dev@test.com']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { stdout: '' },
        'Authentication verified',
      );
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('exits with code 1 when final gh auth status verification fails', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'gh auth status') {
          const error = Object.assign(new Error('not authenticated'), {
            stdout: '',
            stderr: 'You are not logged in',
          });
          throw error;
        }
        return '';
      });

      await runAuthCommand([]);

      expect(mockLogger.error).toHaveBeenCalledWith(
        { stderr: 'You are not logged in' },
        'Authentication verification failed',
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe('logging', () => {
    it('logs initial info message', async () => {
      mockExecBehavior();

      await runAuthCommand([]);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Configuring CLI authentication',
      );
    });
  });
});
