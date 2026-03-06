import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

// Stable mock logger instance — same object returned by every getLogger() call
const mockLogger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

// Mock child_process (spawn used by spawnBackground via exec.ts)
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

// Mock fs
vi.mock('node:fs', () => ({
  createWriteStream: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Mock net.Socket — used by waitForPort
const mockSocketInstance = {
  setTimeout: vi.fn(),
  connect: vi.fn(),
  destroy: vi.fn(),
  on: vi.fn(),
};
vi.mock('node:net', () => ({
  default: {
    Socket: vi.fn(function () { return mockSocketInstance; }),
  },
}));

// Mock the logger
vi.mock('../../cli/utils/logger.js', () => ({
  getLogger: () => mockLogger,
}));

// Import after mocks are set up
const { execSync, spawn } = await import('node:child_process');
const { createWriteStream, existsSync, mkdirSync, readdirSync, writeFileSync } =
  await import('node:fs');
const net = (await import('node:net')).default;
const { setupServicesCommand } = await import(
  '../../cli/commands/setup/services.js'
);

const mockExecSync = execSync as Mock;
const mockSpawn = spawn as Mock;
const mockExistsSync = existsSync as Mock;
const mockMkdirSync = mkdirSync as Mock;
const mockReaddirSync = readdirSync as Mock;
const mockWriteFileSync = writeFileSync as Mock;
const mockCreateWriteStream = createWriteStream as Mock;
const MockSocket = net.Socket as unknown as Mock;

// Track process event listeners for cleanup
let processListeners: Record<string, ((...args: unknown[]) => void)[]>;

beforeEach(() => {
  vi.resetAllMocks();

  // Re-establish MockSocket constructor after resetAllMocks clears it
  MockSocket.mockImplementation(function () { return mockSocketInstance; });

  processListeners = { SIGTERM: [], SIGINT: [] };

  // Capture process signal listeners registered during tests
  vi.spyOn(process, 'on').mockImplementation(((event: string, fn: () => void) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      processListeners[event].push(fn);
    }
    return process;
  }) as typeof process.on);

  vi.spyOn(process, 'kill').mockImplementation((() => true) as unknown as typeof process.kill);

  // Default: createWriteStream returns a mock writable stream
  mockCreateWriteStream.mockReturnValue({
    write: vi.fn(),
    end: vi.fn(),
  });

  // Default: reset socket mock
  mockSocketInstance.setTimeout.mockReturnThis();
  mockSocketInstance.connect.mockReturnThis();
  mockSocketInstance.destroy.mockReturnThis();
  mockSocketInstance.on.mockReturnThis();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Create a mock ChildProcess with pipeable stdout/stderr.
 */
function createMockChildProcess(pid = 12345): ChildProcess {
  const mockStdout = new EventEmitter();
  (mockStdout as unknown as { pipe: Mock }).pipe = vi.fn();
  const mockStderr = new EventEmitter();
  (mockStderr as unknown as { pipe: Mock }).pipe = vi.fn();

  return {
    unref: vi.fn(),
    pid,
    stdin: null,
    stdout: mockStdout,
    stderr: mockStderr,
    stdio: [null, mockStdout, mockStderr, null, null],
    connected: false,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: '',
    killed: false,
    kill: vi.fn(),
    send: vi.fn(),
    disconnect: vi.fn(),
    ref: vi.fn(),
    addListener: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    prependListener: vi.fn(),
    prependOnceListener: vi.fn(),
    removeListener: vi.fn(),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
    setMaxListeners: vi.fn(),
    getMaxListeners: vi.fn(),
    listeners: vi.fn(),
    rawListeners: vi.fn(),
    listenerCount: vi.fn(),
    eventNames: vi.fn(),
    [Symbol.dispose]: vi.fn(),
  } as unknown as ChildProcess;
}

/**
 * Helper: run the services command with given CLI args.
 * Makes waitForPort resolve immediately by default.
 */
async function runServicesCommand(args: string[] = []) {
  const command = setupServicesCommand();
  await command.parseAsync(['node', 'services', ...args]);
}

/**
 * Setup mocks so the command runs without actually waiting for ports.
 * Cloud directories exist, deps installed, already built.
 */
function setupHappyPath() {
  // Both cloud directories exist
  mockExistsSync.mockImplementation((path: string) => {
    return [
      '/workspaces/generacy-cloud',
      '/workspaces/humancy-cloud',
    ].some((p) => path.startsWith(p));
  });

  // node_modules have enough entries (≥ 10)
  mockReaddirSync.mockReturnValue(new Array(50).fill('pkg'));

  // execSync (used by exec/execSafe) succeeds
  mockExecSync.mockReturnValue('');

  // spawn returns mock children with sequential PIDs
  let nextPid = 1000;
  mockSpawn.mockImplementation(() => createMockChildProcess(nextPid++));

  // Socket connects immediately (health check succeeds)
  mockSocketInstance.connect.mockImplementation(
    (_port: number, _host: string, cb: () => void) => {
      cb();
      return mockSocketInstance;
    },
  );
}

describe('setup services command', () => {
  describe('config resolution', () => {
    it('defaults to --only all, no skip-api, timeout 60', async () => {
      setupHappyPath();

      await runServicesCommand();

      expect(mockLogger.info).toHaveBeenCalledWith(
        { only: 'all', skipApi: false, timeout: 60 },
        'Configuration',
      );
    });

    it('respects --only generacy flag', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'generacy']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ only: 'generacy' }),
        'Configuration',
      );
    });

    it('respects --skip-api flag', async () => {
      setupHappyPath();

      await runServicesCommand(['--skip-api']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ skipApi: true }),
        'Configuration',
      );
    });

    it('parses --timeout as a number', async () => {
      setupHappyPath();

      await runServicesCommand(['--timeout', '30']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 30 }),
        'Configuration',
      );
    });
  });

  describe('log directory setup', () => {
    it('creates log directory with recursive option', async () => {
      setupHappyPath();

      await runServicesCommand();

      expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/cloud-services', {
        recursive: true,
      });
    });

    it('truncates existing log files for enabled services', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'generacy']);

      // Should truncate emulator and API logs for generacy
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/tmp/cloud-services/generacy-emulators.log',
        '',
      );
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/tmp/cloud-services/generacy-api.log',
        '',
      );
      // Should NOT truncate humancy logs
      expect(mockWriteFileSync).not.toHaveBeenCalledWith(
        '/tmp/cloud-services/humancy-emulators.log',
        '',
      );
    });

    it('skips API log truncation when --skip-api is set', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'generacy', '--skip-api']);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/tmp/cloud-services/generacy-emulators.log',
        '',
      );
      expect(mockWriteFileSync).not.toHaveBeenCalledWith(
        '/tmp/cloud-services/generacy-api.log',
        '',
      );
    });
  });

  describe('service filtering', () => {
    it('--only generacy spawns only generacy emulator and API', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'generacy']);

      // Emulator spawn: cwd should be generacy-cloud
      const spawnCalls = mockSpawn.mock.calls;
      const emulatorCall = spawnCalls.find(
        (c: unknown[]) => (c[0] as string) === 'firebase',
      );
      expect(emulatorCall).toBeDefined();
      expect(emulatorCall![2]).toEqual(
        expect.objectContaining({ cwd: '/workspaces/generacy-cloud' }),
      );

      // API spawn: cwd should be generacy-cloud/services/api
      const apiCall = spawnCalls.find(
        (c: unknown[]) => (c[0] as string) === 'npx',
      );
      expect(apiCall).toBeDefined();
      expect(apiCall![2]).toEqual(
        expect.objectContaining({
          cwd: '/workspaces/generacy-cloud/services/api',
        }),
      );

      // Should be exactly 2 spawns: 1 emulator + 1 API
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    it('--only humancy spawns only humancy emulator and API', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'humancy']);

      const spawnCalls = mockSpawn.mock.calls;
      const emulatorCall = spawnCalls.find(
        (c: unknown[]) => (c[0] as string) === 'firebase',
      );
      expect(emulatorCall![2]).toEqual(
        expect.objectContaining({ cwd: '/workspaces/humancy-cloud' }),
      );

      const apiCall = spawnCalls.find(
        (c: unknown[]) => (c[0] as string) === 'npx',
      );
      expect(apiCall![2]).toEqual(
        expect.objectContaining({
          cwd: '/workspaces/humancy-cloud/services/api',
        }),
      );

      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    it('--only all (default) spawns both service sets', async () => {
      setupHappyPath();

      await runServicesCommand();

      // 2 emulators + 2 APIs = 4 spawns
      expect(mockSpawn).toHaveBeenCalledTimes(4);

      const spawnCalls = mockSpawn.mock.calls;
      const emulatorCalls = spawnCalls.filter(
        (c: unknown[]) => (c[0] as string) === 'firebase',
      );
      const apiCalls = spawnCalls.filter(
        (c: unknown[]) => (c[0] as string) === 'npx',
      );
      expect(emulatorCalls).toHaveLength(2);
      expect(apiCalls).toHaveLength(2);
    });

    it('--skip-api skips API server spawns', async () => {
      setupHappyPath();

      await runServicesCommand(['--skip-api']);

      // Only emulators: 2 spawns
      expect(mockSpawn).toHaveBeenCalledTimes(2);

      const spawnCalls = mockSpawn.mock.calls;
      const apiCalls = spawnCalls.filter(
        (c: unknown[]) => (c[0] as string) === 'npx',
      );
      expect(apiCalls).toHaveLength(0);
    });
  });

  describe('emulator spawning', () => {
    it('spawns firebase emulators:start with correct cwd', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'generacy']);

      expect(mockSpawn).toHaveBeenCalledWith(
        'firebase',
        ['emulators:start'],
        expect.objectContaining({
          cwd: '/workspaces/generacy-cloud',
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    });

    it('pipes emulator stdout/stderr to log files', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'generacy']);

      expect(mockCreateWriteStream).toHaveBeenCalledWith(
        '/tmp/cloud-services/generacy-emulators.log',
      );

      // The spawned child should have its stdout/stderr piped
      const child = mockSpawn.mock.results[0].value as ChildProcess;
      expect((child.stdout as unknown as { pipe: Mock }).pipe).toHaveBeenCalled();
      expect((child.stderr as unknown as { pipe: Mock }).pipe).toHaveBeenCalled();
    });

    it('logs emulator start with port info', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'generacy']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        {
          service: 'generacy',
          firestore: 8080,
          auth: 9099,
          ui: 4000,
        },
        'Starting Firebase emulators',
      );
    });
  });

  describe('API server spawning', () => {
    it('spawns npx tsx watch with correct args and cwd', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'generacy']);

      expect(mockSpawn).toHaveBeenCalledWith(
        'npx',
        ['tsx', 'watch', 'src/index.ts'],
        expect.objectContaining({
          cwd: '/workspaces/generacy-cloud/services/api',
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    });

    it('sets per-process env vars for generacy API', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'generacy']);

      const apiCall = mockSpawn.mock.calls.find(
        (c: unknown[]) => (c[0] as string) === 'npx',
      );
      const env = (apiCall![2] as { env: Record<string, string> }).env;

      expect(env).toEqual(
        expect.objectContaining({
          FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
          FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
          FIREBASE_PROJECT_ID: 'generacy-cloud',
          PORT: '3010',
        }),
      );
    });

    it('sets different emulator host ports for humancy API', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'humancy']);

      const apiCall = mockSpawn.mock.calls.find(
        (c: unknown[]) => (c[0] as string) === 'npx',
      );
      const env = (apiCall![2] as { env: Record<string, string> }).env;

      expect(env).toEqual(
        expect.objectContaining({
          FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081',
          FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9199',
          FIREBASE_PROJECT_ID: 'humancy-cloud',
          PORT: '3002',
        }),
      );
    });

    it('passes through Stripe env vars with fallback placeholders', async () => {
      setupHappyPath();

      // Ensure Stripe env vars are NOT set
      const origStripeKey = process.env['STRIPE_API_KEY'];
      const origStripeSecret = process.env['STRIPE_SECRET_KEY'];
      const origStripeWebhook = process.env['STRIPE_WEBHOOK_SECRET'];
      delete process.env['STRIPE_API_KEY'];
      delete process.env['STRIPE_SECRET_KEY'];
      delete process.env['STRIPE_WEBHOOK_SECRET'];

      try {
        await runServicesCommand(['--only', 'generacy']);

        const apiCall = mockSpawn.mock.calls.find(
          (c: unknown[]) => (c[0] as string) === 'npx',
        );
        const env = (apiCall![2] as { env: Record<string, string> }).env;

        expect(env['STRIPE_API_KEY']).toBe('sk_test_dev_placeholder');
        expect(env['STRIPE_SECRET_KEY']).toBe('sk_test_dev_placeholder');
        expect(env['STRIPE_WEBHOOK_SECRET']).toBe('whsec_test_dev_placeholder');
      } finally {
        // Restore
        if (origStripeKey !== undefined) process.env['STRIPE_API_KEY'] = origStripeKey;
        if (origStripeSecret !== undefined) process.env['STRIPE_SECRET_KEY'] = origStripeSecret;
        if (origStripeWebhook !== undefined) process.env['STRIPE_WEBHOOK_SECRET'] = origStripeWebhook;
      }
    });

    it('uses actual Stripe env vars when they are set', async () => {
      setupHappyPath();

      const origStripeKey = process.env['STRIPE_API_KEY'];
      process.env['STRIPE_API_KEY'] = 'sk_live_real_key';

      try {
        await runServicesCommand(['--only', 'generacy']);

        const apiCall = mockSpawn.mock.calls.find(
          (c: unknown[]) => (c[0] as string) === 'npx',
        );
        const env = (apiCall![2] as { env: Record<string, string> }).env;

        expect(env['STRIPE_API_KEY']).toBe('sk_live_real_key');
      } finally {
        if (origStripeKey !== undefined) {
          process.env['STRIPE_API_KEY'] = origStripeKey;
        } else {
          delete process.env['STRIPE_API_KEY'];
        }
      }
    });

    it('pipes API stdout/stderr to log files', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'generacy']);

      expect(mockCreateWriteStream).toHaveBeenCalledWith(
        '/tmp/cloud-services/generacy-api.log',
      );
    });
  });

  describe('dependency and build checks', () => {
    it('skips service when cloud directory does not exist', async () => {
      setupHappyPath();
      mockExistsSync.mockReturnValue(false);

      await runServicesCommand(['--only', 'generacy']);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { service: 'generacy', dir: '/workspaces/generacy-cloud' },
        'Cloud directory not found, skipping',
      );
      // No spawns should occur
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('runs pnpm install when node_modules has fewer than 10 entries', async () => {
      setupHappyPath();
      // Return only 5 entries — below the threshold
      mockReaddirSync.mockReturnValue(new Array(5).fill('pkg'));

      await runServicesCommand(['--only', 'generacy']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { service: 'generacy' },
        'Installing dependencies',
      );
    });

    it('skips pnpm install when node_modules has 10+ entries', async () => {
      setupHappyPath();
      // Already has enough entries
      mockReaddirSync.mockReturnValue(new Array(50).fill('pkg'));

      await runServicesCommand(['--only', 'generacy']);

      expect(mockLogger.info).not.toHaveBeenCalledWith(
        { service: 'generacy' },
        'Installing dependencies',
      );
    });

    it('builds when services/api/dist is missing', async () => {
      setupHappyPath();
      // existsSync: cloud dir exists, but api dist does not
      mockExistsSync.mockImplementation((path: string) => {
        if (path.includes('services/api/dist')) return false;
        return path.startsWith('/workspaces/generacy-cloud') ||
          path.startsWith('/workspaces/humancy-cloud');
      });

      await runServicesCommand(['--only', 'generacy']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { service: 'generacy' },
        'Building',
      );
    });
  });

  describe('health checks', () => {
    it('reports ready when socket connects successfully', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'generacy']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { service: 'generacy', port: 8080 },
        'Firestore emulator ready',
      );
    });

    it('reports ready for API server port', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'generacy']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { service: 'generacy', port: 3010 },
        'API server ready',
      );
    });

    it('warns when port does not become ready within timeout', async () => {
      setupHappyPath();

      // Override Socket to always error (port never ready)
      mockSocketInstance.connect.mockImplementation(
        (_port: number, _host: string, _cb: () => void) => {
          // Don't call cb — trigger error instead
          return mockSocketInstance;
        },
      );
      mockSocketInstance.on.mockImplementation((event: string, cb: (err: Error) => void) => {
        if (event === 'error') {
          // Fire error asynchronously
          setTimeout(() => cb(new Error('ECONNREFUSED')), 0);
        }
        return mockSocketInstance;
      });

      await runServicesCommand(['--only', 'generacy', '--timeout', '1']);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'generacy', port: 8080 }),
        'Firestore emulator not ready after timeout',
      );
    });

    it('skips API health check when --skip-api is set', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'generacy', '--skip-api']);

      // Should NOT check API port
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ port: 3010 }),
        'API server ready',
      );
    });
  });

  describe('graceful shutdown', () => {
    it('registers SIGTERM and SIGINT handlers', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'generacy']);

      expect(processListeners['SIGTERM']).toHaveLength(1);
      expect(processListeners['SIGINT']).toHaveLength(1);
    });

    it('sends SIGTERM to all children on shutdown', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'generacy']);

      // Get PIDs from spawned children
      const spawnedPids = mockSpawn.mock.results.map(
        (r: { value: ChildProcess }) => r.value.pid,
      );
      expect(spawnedPids.length).toBeGreaterThan(0);

      // Trigger shutdown
      const shutdownHandler = processListeners['SIGTERM'][0];
      shutdownHandler();

      // Should send SIGTERM (as negative PID for process group) to each child
      for (const pid of spawnedPids) {
        expect(process.kill).toHaveBeenCalledWith(-pid, 'SIGTERM');
      }
    });

    it('sends SIGKILL after 5 second timeout', async () => {
      vi.useFakeTimers();
      setupHappyPath();

      await runServicesCommand(['--only', 'generacy']);

      const spawnedPids = mockSpawn.mock.results.map(
        (r: { value: ChildProcess }) => r.value.pid,
      );

      // Trigger shutdown
      const shutdownHandler = processListeners['SIGTERM'][0];
      shutdownHandler();

      // Clear the initial SIGTERM calls from the mock
      (process.kill as unknown as Mock).mockClear();

      // Advance timer by 5 seconds
      vi.advanceTimersByTime(5000);

      // Should send SIGKILL to each child
      for (const pid of spawnedPids) {
        expect(process.kill).toHaveBeenCalledWith(-pid, 'SIGKILL');
      }

      vi.useRealTimers();
    });

    it('handles already-dead processes gracefully', async () => {
      setupHappyPath();

      await runServicesCommand(['--only', 'generacy']);

      // Make process.kill throw (process already dead)
      (process.kill as unknown as Mock).mockImplementation(() => {
        throw new Error('ESRCH');
      });

      // Should not throw
      const shutdownHandler = processListeners['SIGTERM'][0];
      expect(() => shutdownHandler()).not.toThrow();
    });
  });

  describe('completion logging', () => {
    it('logs cloud services started with log directory', async () => {
      setupHappyPath();

      await runServicesCommand();

      expect(mockLogger.info).toHaveBeenCalledWith(
        { logDir: '/tmp/cloud-services' },
        'Cloud services started',
      );
    });

    it('logs initial message about starting cloud backend services', async () => {
      setupHappyPath();

      await runServicesCommand();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Starting cloud backend services',
      );
    });
  });
});
