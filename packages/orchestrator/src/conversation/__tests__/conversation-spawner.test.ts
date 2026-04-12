import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { ConversationSpawner } from '../conversation-spawner.js';
import type { AgentLauncher } from '../../launcher/agent-launcher.js';
import type { ChildProcessHandle } from '../../worker/types.js';
import type { LaunchHandle, OutputParser } from '../../launcher/types.js';

const noopParser: OutputParser = {
  processChunk() {},
  flush() {},
};

function createMockProcess() {
  const stdin = new EventEmitter();
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

function createMockLauncher(handle: ChildProcessHandle) {
  const launchFn = vi.fn().mockReturnValue({
    process: handle,
    outputParser: noopParser,
    metadata: { pluginId: 'claude-code', intentKind: 'conversation-turn' },
  } satisfies LaunchHandle);
  return { launch: launchFn } as unknown as AgentLauncher;
}

describe('ConversationSpawner', () => {
  describe('spawnTurn', () => {
    it('launches via agentLauncher with conversation-turn intent', () => {
      const { handle } = createMockProcess();
      const launcher = createMockLauncher(handle);
      const spawner = new ConversationSpawner(launcher);

      spawner.spawnTurn({
        cwd: '/workspace',
        message: 'hello',
        skipPermissions: true,
      });

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: expect.objectContaining({
            kind: 'conversation-turn',
            message: 'hello',
            skipPermissions: true,
          }),
          cwd: '/workspace',
          env: {},
        }),
      );
    });

    it('passes sessionId in intent when provided', () => {
      const { handle } = createMockProcess();
      const launcher = createMockLauncher(handle);
      const spawner = new ConversationSpawner(launcher);

      spawner.spawnTurn({
        cwd: '/workspace',
        message: 'hello',
        sessionId: 'ses-123',
        skipPermissions: true,
      });

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: expect.objectContaining({
            kind: 'conversation-turn',
            sessionId: 'ses-123',
          }),
        }),
      );
    });

    it('passes model in intent when provided', () => {
      const { handle } = createMockProcess();
      const launcher = createMockLauncher(handle);
      const spawner = new ConversationSpawner(launcher);

      spawner.spawnTurn({
        cwd: '/workspace',
        message: 'hello',
        skipPermissions: true,
        model: 'claude-opus-4-6',
      });

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: expect.objectContaining({
            model: 'claude-opus-4-6',
          }),
        }),
      );
    });

    it('sets skipPermissions to false when disabled', () => {
      const { handle } = createMockProcess();
      const launcher = createMockLauncher(handle);
      const spawner = new ConversationSpawner(launcher);

      spawner.spawnTurn({
        cwd: '/workspace',
        message: 'hello',
        skipPermissions: false,
      });

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: expect.objectContaining({
            skipPermissions: false,
          }),
        }),
      );
    });

    it('returns the process handle from LaunchHandle', () => {
      const { handle } = createMockProcess();
      const launcher = createMockLauncher(handle);
      const spawner = new ConversationSpawner(launcher);

      const result = spawner.spawnTurn({
        cwd: '/workspace',
        message: 'hello',
        skipPermissions: true,
      });

      expect(result.pid).toBe(54321);
      expect(result.stdout).not.toBeNull();
    });
  });

  describe('spawnTurn — LaunchRequest snapshot', () => {
    it('captures full LaunchRequest for a conversation turn', () => {
      const { handle } = createMockProcess();
      const launcher = createMockLauncher(handle);
      const spawner = new ConversationSpawner(launcher);

      spawner.spawnTurn({
        cwd: '/workspace',
        message: 'Tell me about TypeScript',
        sessionId: 'ses-abc',
        model: 'claude-sonnet-4-6',
        skipPermissions: true,
      });

      const request = (launcher.launch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(request).toMatchSnapshot();
    });
  });


  describe('gracefulKill', () => {
    it('sends SIGTERM first', () => {
      const launcher = { launch: vi.fn() } as unknown as AgentLauncher;
      const spawner = new ConversationSpawner(launcher, 50);
      const { handle } = createMockProcess();

      spawner.gracefulKill(handle);

      expect(handle.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('sends SIGKILL after grace period if process is still alive', async () => {
      vi.useFakeTimers();
      const launcher = { launch: vi.fn() } as unknown as AgentLauncher;
      const spawner = new ConversationSpawner(launcher, 100);

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
