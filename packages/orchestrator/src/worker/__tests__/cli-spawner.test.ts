import { EventEmitter } from 'node:events';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CliSpawner } from '../cli-spawner.js';
import { WorkerConfigSchema } from '../config.js';
import type {
  ProcessFactory,
  ChildProcessHandle,
  Logger,
  CliSpawnOptions,
} from '../types.js';
import type { OutputCapture } from '../output-capture.js';
import { AgentLauncher } from '../../launcher/agent-launcher.js';
import { GenericSubprocessPlugin } from '../../launcher/generic-subprocess-plugin.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';

// ---------------------------------------------------------------------------
// Mock Logger
// ---------------------------------------------------------------------------
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

// ---------------------------------------------------------------------------
// Mock Process Helper
// ---------------------------------------------------------------------------
function createMockProcess(exitCode = 0, exitDelay = 10) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let exitResolve: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((resolve) => {
    exitResolve = resolve;
  });

  const handle: ChildProcessHandle = {
    stdin: null,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    pid: 12345,
    kill: vi.fn((signal?: string) => {
      if (signal === 'SIGKILL' || signal === 'SIGTERM') {
        exitResolve(exitCode);
      }
      return true;
    }),
    exitPromise,
  };

  // Auto-exit after delay (negative means manual control)
  if (exitDelay >= 0) {
    setTimeout(() => exitResolve(exitCode), exitDelay);
  }

  return { handle, stdout, stderr, resolve: exitResolve! };
}

// ---------------------------------------------------------------------------
// Mock OutputCapture
// ---------------------------------------------------------------------------
function createMockCapture() {
  return {
    processChunk: vi.fn(),
    flush: vi.fn(),
    getOutput: vi.fn().mockReturnValue([]),
    clear: vi.fn(),
  } as unknown as OutputCapture;
}

// ---------------------------------------------------------------------------
// Default spawn options
// ---------------------------------------------------------------------------
function defaultOptions(overrides: Partial<CliSpawnOptions> = {}): CliSpawnOptions {
  return {
    prompt: 'do something',
    cwd: '/tmp/repo',
    env: { PATH: '/usr/bin' },
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('CliSpawner', () => {
  let spawner: CliSpawner;
  let factory: ProcessFactory;
  let spawnFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    spawnFn = vi.fn();
    factory = { spawn: spawnFn } as unknown as ProcessFactory;
    // Wire AgentLauncher with real plugins and mock factory
    const agentLauncher = new AgentLauncher(new Map([['default', factory]]));
    agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin());
    agentLauncher.registerPlugin(new GenericSubprocessPlugin());
    // Use a short grace period (50ms) for tests
    spawner = new CliSpawner(agentLauncher, mockLogger, 50);
  });

  describe('spawnPhase - successful spawn', () => {
    it('returns PhaseResult with success=true when exit code is 0', async () => {
      const { handle } = createMockProcess(0, 10);
      spawnFn.mockReturnValue(handle);
      const capture = createMockCapture();

      const result = await spawner.spawnPhase('clarify', defaultOptions(), capture);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.phase).toBe('clarify');
      expect(result.error).toBeUndefined();
    });
  });

  describe('spawnPhase - session resume', () => {
    it('does not pass --resume when no resumeSessionId is provided', async () => {
      const { handle } = createMockProcess(0, 10);
      spawnFn.mockReturnValue(handle);
      const capture = createMockCapture();

      await spawner.spawnPhase('clarify', defaultOptions(), capture);

      const spawnArgs = spawnFn.mock.calls[0]![1] as string[];
      expect(spawnArgs).not.toContain('--resume');
    });

    it('passes --resume flag when resumeSessionId is provided', async () => {
      const { handle } = createMockProcess(0, 10);
      spawnFn.mockReturnValue(handle);
      const capture = createMockCapture();

      await spawner.spawnPhase(
        'plan',
        defaultOptions({ resumeSessionId: 'ses-abc-123' }),
        capture,
      );

      const spawnArgs = spawnFn.mock.calls[0]![1] as string[];
      const resumeIndex = spawnArgs.indexOf('--resume');
      expect(resumeIndex).toBeGreaterThan(-1);
      expect(spawnArgs[resumeIndex + 1]).toBe('ses-abc-123');
    });

    it('places --resume before the prompt positional arg', async () => {
      const { handle } = createMockProcess(0, 10);
      spawnFn.mockReturnValue(handle);
      const capture = createMockCapture();

      await spawner.spawnPhase(
        'plan',
        defaultOptions({ resumeSessionId: 'ses-abc-123' }),
        capture,
      );

      const spawnArgs = spawnFn.mock.calls[0]![1] as string[];
      const resumeIndex = spawnArgs.indexOf('--resume');
      // Prompt is always the last positional argument
      expect(resumeIndex).toBeLessThan(spawnArgs.length - 1);
    });

    it('includes sessionId from capture in PhaseResult', async () => {
      const { handle } = createMockProcess(0, 10);
      spawnFn.mockReturnValue(handle);
      const capture = createMockCapture();
      (capture as any).sessionId = 'ses-from-output';

      const result = await spawner.spawnPhase('clarify', defaultOptions(), capture);

      expect(result.sessionId).toBe('ses-from-output');
    });
  });

  describe('spawnPhase - non-zero exit code', () => {
    it('returns PhaseResult with success=false and error set', async () => {
      const { handle } = createMockProcess(1, 10);
      spawnFn.mockReturnValue(handle);
      const capture = createMockCapture();

      const result = await spawner.spawnPhase('plan', defaultOptions(), capture);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('failed with exit code 1');
      expect(result.error!.phase).toBe('plan');
    });
  });

  describe('stdout capture', () => {
    it('calls OutputCapture.processChunk when stdout emits data', async () => {
      const { handle, stdout } = createMockProcess(0, 50);
      spawnFn.mockReturnValue(handle);
      const capture = createMockCapture();

      const promise = spawner.spawnPhase('clarify', defaultOptions(), capture);

      // Emit data on stdout after listeners are attached
      setTimeout(() => {
        stdout.emit('data', '{"type":"init"}\n');
      }, 5);

      await promise;

      expect(capture.processChunk).toHaveBeenCalledWith('{"type":"init"}\n');
      expect(capture.flush).toHaveBeenCalled();
    });
  });

  describe('stderr capture', () => {
    it('includes stderr in error.stderr when process fails', async () => {
      const { handle, stderr } = createMockProcess(1, 50);
      spawnFn.mockReturnValue(handle);
      const capture = createMockCapture();

      const promise = spawner.spawnPhase('implement', defaultOptions(), capture);

      setTimeout(() => {
        stderr.emit('data', 'something went wrong');
      }, 5);

      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.stderr).toContain('something went wrong');
    });
  });

  describe('timeout triggers SIGTERM then SIGKILL', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sends SIGTERM on timeout, then SIGKILL after grace period', async () => {
      // Create a custom mock where SIGTERM does NOT resolve the exitPromise,
      // simulating a stubborn process that only dies on SIGKILL.
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      let exitResolve: (code: number | null) => void;
      const exitPromise = new Promise<number | null>((resolve) => {
        exitResolve = resolve;
      });

      const handle: ChildProcessHandle = {
        stdin: null,
        stdout: stdout as unknown as NodeJS.ReadableStream,
        stderr: stderr as unknown as NodeJS.ReadableStream,
        pid: 12345,
        kill: vi.fn((signal?: string) => {
          // Only resolve on SIGKILL — SIGTERM alone won't stop this process
          if (signal === 'SIGKILL') {
            exitResolve!(1);
          }
          return true;
        }),
        exitPromise,
      };

      spawnFn.mockReturnValue(handle);
      const capture = createMockCapture();

      const options = defaultOptions({ timeoutMs: 1000 });
      const resultPromise = spawner.spawnPhase('implement', options, capture);

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(1000);

      // SIGTERM should have been called
      expect(handle.kill).toHaveBeenCalledWith('SIGTERM');

      // Advance past grace period (50ms)
      await vi.advanceTimersByTimeAsync(50);

      // SIGKILL should also have been called
      expect(handle.kill).toHaveBeenCalledWith('SIGKILL');

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error!.message).toContain('timed out');
    });
  });

  describe('abort signal kills process', () => {
    it('sends SIGTERM when abort signal fires', async () => {
      const { handle } = createMockProcess(1, -1);
      spawnFn.mockReturnValue(handle);
      const capture = createMockCapture();

      const abortController = new AbortController();
      const options = defaultOptions({ signal: abortController.signal });

      const resultPromise = spawner.spawnPhase('clarify', options, capture);

      // Fire abort
      abortController.abort();

      const result = await resultPromise;

      expect(handle.kill).toHaveBeenCalledWith('SIGTERM');
      expect(result.success).toBe(false);
      expect(result.error!.message).toContain('aborted');
    });
  });

  describe('runValidatePhase', () => {
    it('spawns with sh -c <command>', async () => {
      const { handle } = createMockProcess(0, 10);
      spawnFn.mockReturnValue(handle);

      const abortController = new AbortController();
      const result = await spawner.runValidatePhase(
        '/tmp/repo',
        'pnpm test && pnpm build',
        abortController.signal,
      );

      expect(spawnFn).toHaveBeenCalledWith(
        'sh',
        ['-c', 'pnpm test && pnpm build'],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
      expect(result.success).toBe(true);
      expect(result.phase).toBe('validate');
    });
  });

  describe('runPreValidateInstall', () => {
    it('spawns sh -c with the install command and correct cwd', async () => {
      const { handle } = createMockProcess(0, 10);
      spawnFn.mockReturnValue(handle);

      const abortController = new AbortController();
      const result = await spawner.runPreValidateInstall(
        '/tmp/repo',
        'pnpm install',
        abortController.signal,
      );

      expect(spawnFn).toHaveBeenCalledWith(
        'sh',
        ['-c', 'pnpm install'],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
      expect(result.success).toBe(true);
      expect(result.phase).toBe('validate');
    });

    it('returns failure when install command exits non-zero', async () => {
      const { handle } = createMockProcess(1, 10);
      spawnFn.mockReturnValue(handle);

      const abortController = new AbortController();
      const result = await spawner.runPreValidateInstall(
        '/tmp/repo',
        'pnpm install',
        abortController.signal,
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.error).toBeDefined();
    });

    it('uses 5-minute timeout', async () => {
      vi.useFakeTimers();

      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      let exitResolve: (code: number | null) => void;
      const exitPromise = new Promise<number | null>((resolve) => {
        exitResolve = resolve;
      });

      const handle: ChildProcessHandle = {
        stdin: null,
        stdout: stdout as unknown as NodeJS.ReadableStream,
        stderr: stderr as unknown as NodeJS.ReadableStream,
        pid: 12345,
        kill: vi.fn((signal?: string) => {
          if (signal === 'SIGKILL') {
            exitResolve!(1);
          }
          return true;
        }),
        exitPromise,
      };

      spawnFn.mockReturnValue(handle);

      const abortController = new AbortController();
      const resultPromise = spawner.runPreValidateInstall(
        '/tmp/repo',
        'pnpm install',
        abortController.signal,
      );

      // Advance to 5 minutes (300,000ms)
      await vi.advanceTimersByTimeAsync(300_000);
      expect(handle.kill).toHaveBeenCalledWith('SIGTERM');

      // Advance past grace period
      await vi.advanceTimersByTimeAsync(50);
      expect(handle.kill).toHaveBeenCalledWith('SIGKILL');

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error!.message).toContain('timed out');

      vi.useRealTimers();
    });
  });
});

describe('WorkerConfigSchema - preValidateCommand', () => {
  it('defaults to pnpm install && pnpm -r --filter ./packages/* build', () => {
    const config = WorkerConfigSchema.parse({});
    expect(config.preValidateCommand).toBe('pnpm install && pnpm -r --filter ./packages/* build');
  });

  it('accepts empty string', () => {
    const config = WorkerConfigSchema.parse({ preValidateCommand: '' });
    expect(config.preValidateCommand).toBe('');
  });

  it('accepts custom command', () => {
    const config = WorkerConfigSchema.parse({ preValidateCommand: 'npm ci' });
    expect(config.preValidateCommand).toBe('npm ci');
  });
});
