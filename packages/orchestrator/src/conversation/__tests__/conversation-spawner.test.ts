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
