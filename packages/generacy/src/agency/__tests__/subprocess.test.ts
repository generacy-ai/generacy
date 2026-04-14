import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SubprocessAgency } from '../subprocess.js';
import type { SubprocessAgencyOptions } from '../subprocess.js';
import type { AgentLauncher, LaunchHandle } from '@generacy-ai/orchestrator';

/** Minimal mock logger */
function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  };
}

/** Create a mock ChildProcessHandle with wirable streams */
function createMockHandle(opts?: { exitCode?: number; rejectWith?: Error }) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream;

  let resolveExit: (code: number | null) => void;
  let rejectExit: (err: Error) => void;
  const exitPromise = new Promise<number | null>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });

  // Auto-resolve or reject after microtask if configured
  if (opts?.rejectWith) {
    void Promise.resolve().then(() => rejectExit(opts.rejectWith!));
  }

  return {
    handle: {
      stdin,
      stdout: stdout as unknown as NodeJS.ReadableStream,
      stderr: stderr as unknown as NodeJS.ReadableStream,
      pid: 42,
      kill: vi.fn(() => true),
      exitPromise,
    },
    stdout,
    stderr,
    resolveExit: resolveExit!,
    rejectExit: rejectExit!,
  };
}

function createMockLauncher(handle: ReturnType<typeof createMockHandle>['handle']): AgentLauncher {
  const launchHandle: LaunchHandle = {
    process: handle,
    outputParser: { processChunk: vi.fn(), flush: vi.fn() },
    metadata: { pluginId: 'generic-subprocess', intentKind: 'generic-subprocess' },
  };
  return {
    launch: vi.fn(() => Promise.resolve(launchHandle)),
    registerPlugin: vi.fn(),
  } as unknown as AgentLauncher;
}

const baseOptions: SubprocessAgencyOptions = {
  command: 'node',
  args: ['agent.js'],
  logger: createMockLogger(),
  timeout: 1000,
  cwd: '/tmp',
  env: { MY_VAR: 'val' },
};

describe('SubprocessAgency', () => {
  describe('launcher path', () => {
    it('calls agentLauncher.launch() with correct intent', async () => {
      const mock = createMockHandle();
      const launcher = createMockLauncher(mock.handle);
      const agency = new SubprocessAgency(baseOptions, launcher);

      // Start connect (don't await — we need to inspect the launch call)
      const connectPromise = agency.connect();

      expect(launcher.launch).toHaveBeenCalledWith({
        intent: {
          kind: 'generic-subprocess',
          command: 'node',
          args: ['agent.js'],
          stdioProfile: 'interactive',
        },
        cwd: '/tmp',
        env: { MY_VAR: 'val' },
      });

      // launch() is async — flush microtasks so the .then() attaches stream handlers
      await Promise.resolve();

      // Respond to init message so connect resolves
      const initResponse = JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        result: { protocolVersion: '2024-11-05' },
      });
      mock.stdout.emit('data', Buffer.from(initResponse + '\n'));

      return connectPromise;
    });

    it('wires stdout data through handleData', async () => {
      const mock = createMockHandle();
      const launcher = createMockLauncher(mock.handle);
      const logger = createMockLogger();
      const agency = new SubprocessAgency({ ...baseOptions, logger }, launcher);

      const connectPromise = agency.connect();

      // launch() is async — flush microtasks so the .then() attaches stream handlers
      await Promise.resolve();

      // Respond to init
      const initResponse = JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} });
      mock.stdout.emit('data', Buffer.from(initResponse + '\n'));
      await connectPromise;

      expect(agency.isConnected()).toBe(true);
    });

    it('wires stderr to logger.warn', async () => {
      const mock = createMockHandle();
      const launcher = createMockLauncher(mock.handle);
      const logger = createMockLogger();
      const agency = new SubprocessAgency({ ...baseOptions, logger }, launcher);

      const connectPromise = agency.connect();

      // launch() is async — flush microtasks so the .then() attaches stream handlers
      await Promise.resolve();

      // Emit stderr data
      mock.stderr.emit('data', Buffer.from('some warning'));

      // Respond to init
      const initResponse = JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} });
      mock.stdout.emit('data', Buffer.from(initResponse + '\n'));
      await connectPromise;

      expect(logger.warn).toHaveBeenCalledWith('Agency stderr: some warning');
    });

    it('writes to stdin via sendMessage', async () => {
      const mock = createMockHandle();
      const launcher = createMockLauncher(mock.handle);
      const agency = new SubprocessAgency(baseOptions, launcher);

      const connectPromise = agency.connect();

      // launch() is async — flush microtasks so the .then() calls sendMessage
      await Promise.resolve();

      // Init message should have been written to stdin
      expect(mock.handle.stdin.write).toHaveBeenCalled();
      const written = (mock.handle.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const parsed = JSON.parse(written.trim());
      expect(parsed.method).toBe('initialize');

      // Respond to init
      mock.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} }) + '\n'));
      await connectPromise;
    });
  });

  describe('fallback path (no launcher)', () => {
    it('creates SubprocessAgency without launcher', () => {
      const agency = new SubprocessAgency(baseOptions);
      expect(agency.isConnected()).toBe(false);
    });
  });

  describe('error propagation (launcher path)', () => {
    it('rejects connect() when launcher.launch() throws', async () => {
      const launcher = {
        launch: vi.fn(() => { throw new Error('Plugin not found'); }),
        registerPlugin: vi.fn(),
      } as unknown as AgentLauncher;

      const agency = new SubprocessAgency(baseOptions, launcher);
      await expect(agency.connect()).rejects.toThrow('Plugin not found');
    });

    it('rejects connect() when exitPromise rejects (spawn error)', async () => {
      const mock = createMockHandle({ rejectWith: new Error('spawn ENOENT') });
      const launcher = createMockLauncher(mock.handle);
      const agency = new SubprocessAgency(baseOptions, launcher);

      await expect(agency.connect()).rejects.toThrow('spawn ENOENT');
    });
  });

  describe('disconnect', () => {
    it('kills process via ProcessHandle.kill()', async () => {
      const mock = createMockHandle();
      const launcher = createMockLauncher(mock.handle);
      const agency = new SubprocessAgency(baseOptions, launcher);

      const connectPromise = agency.connect();
      // launch() is async — flush microtasks so the .then() attaches stream handlers
      await Promise.resolve();
      mock.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} }) + '\n'));
      await connectPromise;

      await agency.disconnect();
      expect(mock.handle.kill).toHaveBeenCalled();
      expect(agency.isConnected()).toBe(false);
    });
  });

  describe('type-level: SubprocessAgencyOptions unchanged', () => {
    it('accepts the original shape without new required fields', () => {
      // This test verifies that the original SubprocessAgencyOptions shape
      // is still valid — no new required fields were added.
      const opts: SubprocessAgencyOptions = {
        command: 'echo',
        logger: createMockLogger(),
      };

      // Should construct without error (no launcher = fallback path)
      const agency = new SubprocessAgency(opts);
      expect(agency).toBeDefined();
    });

    it('accepts all optional fields from original shape', () => {
      const opts: SubprocessAgencyOptions = {
        command: 'echo',
        args: ['hello'],
        logger: createMockLogger(),
        timeout: 5000,
        cwd: '/tmp',
        env: { FOO: 'bar' },
      };

      const agency = new SubprocessAgency(opts);
      expect(agency).toBeDefined();
    });
  });
});
