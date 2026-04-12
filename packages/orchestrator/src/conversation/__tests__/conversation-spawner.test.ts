import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { ConversationSpawner } from '../conversation-spawner.js';
import type { ProcessFactory, ChildProcessHandle } from '../../worker/types.js';

function createMockProcess(options?: { withStdin?: boolean }) {
  const stdin = options?.withStdin !== false ? new EventEmitter() : null;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let exitResolve: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((resolve) => {
    exitResolve = resolve;
  });

  const handle: ChildProcessHandle = {
    stdin: stdin as unknown as NodeJS.WritableStream | null,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    pid: 54321,
    kill: vi.fn((signal?: string) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        exitResolve(1);
      }
      return true;
    }),
    exitPromise,
  };

  return { handle, stdin, stdout, stderr, resolve: exitResolve! };
}

describe('ConversationSpawner', () => {
  describe('spawn', () => {
    it('spawns claude via python3 PTY wrapper with --output-format stream-json', () => {
      const spawnFn = vi.fn();
      const { handle } = createMockProcess();
      spawnFn.mockReturnValue(handle);
      const factory = { spawn: spawnFn } as unknown as ProcessFactory;
      const spawner = new ConversationSpawner(factory);

      spawner.spawn({ cwd: '/workspace', skipPermissions: true });

      expect(spawnFn).toHaveBeenCalledWith(
        'python3',
        expect.arrayContaining(['claude', '--output-format', 'stream-json']),
        expect.objectContaining({ cwd: '/workspace' }),
      );
    });

    it('includes --dangerously-skip-permissions when skipPermissions is true', () => {
      const spawnFn = vi.fn();
      const { handle } = createMockProcess();
      spawnFn.mockReturnValue(handle);
      const factory = { spawn: spawnFn } as unknown as ProcessFactory;
      const spawner = new ConversationSpawner(factory);

      spawner.spawn({ cwd: '/workspace', skipPermissions: true });

      const args = spawnFn.mock.calls[0][1] as string[];
      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('does not include --dangerously-skip-permissions when skipPermissions is false', () => {
      const spawnFn = vi.fn();
      const { handle } = createMockProcess();
      spawnFn.mockReturnValue(handle);
      const factory = { spawn: spawnFn } as unknown as ProcessFactory;
      const spawner = new ConversationSpawner(factory);

      spawner.spawn({ cwd: '/workspace', skipPermissions: false });

      const args = spawnFn.mock.calls[0][1] as string[];
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('includes --model when model is specified', () => {
      const spawnFn = vi.fn();
      const { handle } = createMockProcess();
      spawnFn.mockReturnValue(handle);
      const factory = { spawn: spawnFn } as unknown as ProcessFactory;
      const spawner = new ConversationSpawner(factory);

      spawner.spawn({ cwd: '/workspace', skipPermissions: true, model: 'claude-opus-4-6' });

      const args = spawnFn.mock.calls[0][1] as string[];
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-6');
    });

    it('throws if stdin is not available', () => {
      const spawnFn = vi.fn();
      const { handle } = createMockProcess({ withStdin: false });
      spawnFn.mockReturnValue(handle);
      const factory = { spawn: spawnFn } as unknown as ProcessFactory;
      const spawner = new ConversationSpawner(factory);

      expect(() => {
        spawner.spawn({ cwd: '/workspace', skipPermissions: true });
      }).toThrow('Failed to open stdin');
    });

    it('returns a handle with stdin', () => {
      const spawnFn = vi.fn();
      const { handle } = createMockProcess();
      spawnFn.mockReturnValue(handle);
      const factory = { spawn: spawnFn } as unknown as ProcessFactory;
      const spawner = new ConversationSpawner(factory);

      const result = spawner.spawn({ cwd: '/workspace', skipPermissions: true });

      expect(result.stdin).not.toBeNull();
      expect(result.stdout).not.toBeNull();
    });
  });

  describe('gracefulKill', () => {
    it('sends SIGTERM first', () => {
      const factory = { spawn: vi.fn() } as unknown as ProcessFactory;
      const spawner = new ConversationSpawner(factory, 50);
      const { handle } = createMockProcess();

      spawner.gracefulKill(handle);

      expect(handle.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('sends SIGKILL after grace period if process is still alive', async () => {
      vi.useFakeTimers();
      const factory = { spawn: vi.fn() } as unknown as ProcessFactory;
      const spawner = new ConversationSpawner(factory, 100);

      // Create a process that does NOT exit on SIGTERM
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
        pid: 99999,
        kill: vi.fn((signal?: string) => {
          if (signal === 'SIGKILL') {
            exitResolve(1);
          }
          return true;
        }),
        exitPromise,
      };

      spawner.gracefulKill(handle);

      expect(handle.kill).toHaveBeenCalledWith('SIGTERM');
      expect(handle.kill).not.toHaveBeenCalledWith('SIGKILL');

      await vi.advanceTimersByTimeAsync(100);

      expect(handle.kill).toHaveBeenCalledWith('SIGKILL');

      vi.useRealTimers();
    });
  });
});
