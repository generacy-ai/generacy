import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationManager } from '../conversation-manager.js';
import { ConversationSpawner } from '../conversation-spawner.js';
import type { ConversationConfig } from '../../config/schema.js';
import type { Logger, ChildProcessHandle } from '../../worker/types.js';
import type { ConversationOutputEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
};

function createConfig(overrides: Partial<ConversationConfig> = {}): ConversationConfig {
  return {
    maxConcurrent: 3,
    shutdownGracePeriodMs: 5000,
    workspaces: { primary: '/workspace/primary', dev: '/workspace/dev' },
    ...overrides,
  };
}

function createMockProcessHandle(): {
  handle: ChildProcessHandle;
  stdin: EventEmitter;
  stdout: EventEmitter;
  stderr: EventEmitter;
  resolveExit: (code: number | null) => void;
} {
  const stdin = new EventEmitter();
  (stdin as any).write = vi.fn().mockReturnValue(true);
  (stdin as any).end = vi.fn();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let resolveExit: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });

  const handle: ChildProcessHandle = {
    stdin: stdin as unknown as NodeJS.WritableStream,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    pid: 12345,
    kill: vi.fn(() => true),
    exitPromise,
  };

  return { handle, stdin, stdout, stderr, resolveExit: resolveExit! };
}

function createSpawnerMock(processHandle: ChildProcessHandle) {
  const spawner = {
    spawn: vi.fn().mockReturnValue(processHandle),
    gracefulKill: vi.fn((handle: ChildProcessHandle) => {
      handle.kill('SIGTERM');
    }),
  } as unknown as ConversationSpawner;
  return spawner;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ConversationManager', () => {
  let config: ConversationConfig;
  let proc: ReturnType<typeof createMockProcessHandle>;
  let spawner: ConversationSpawner;
  let manager: ConversationManager;

  beforeEach(() => {
    vi.clearAllMocks();
    config = createConfig();
    proc = createMockProcessHandle();
    spawner = createSpawnerMock(proc.handle);
    manager = new ConversationManager(config, spawner, mockLogger);
  });

  describe('start', () => {
    it('starts a conversation and returns ConversationInfo', async () => {
      const info = await manager.start({
        conversationId: 'conv-1',
        workingDirectory: 'primary',
      });

      expect(info.conversationId).toBe('conv-1');
      expect(info.workspaceId).toBe('primary');
      expect(info.state).toBe('active');
      expect(info.skipPermissions).toBe(true);
      expect(spawner.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/workspace/primary',
          skipPermissions: true,
        }),
      );
    });

    it('sends initial command if provided', async () => {
      await manager.start({
        conversationId: 'conv-1',
        workingDirectory: 'primary',
        initialCommand: '/onboard-evaluate',
      });

      expect(proc.stdin.write).toHaveBeenCalledWith('/onboard-evaluate\n');
    });

    it('uses configured default model', async () => {
      config = createConfig({ defaultModel: 'claude-sonnet-4-6' });
      manager = new ConversationManager(config, spawner, mockLogger);

      const info = await manager.start({
        conversationId: 'conv-1',
        workingDirectory: 'primary',
      });

      expect(info.model).toBe('claude-sonnet-4-6');
    });

    it('rejects duplicate conversation ID with 409', async () => {
      await manager.start({
        conversationId: 'conv-1',
        workingDirectory: 'primary',
      });

      await expect(
        manager.start({
          conversationId: 'conv-1',
          workingDirectory: 'primary',
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('rejects when at max concurrency with 429', async () => {
      config = createConfig({ maxConcurrent: 1 });
      manager = new ConversationManager(config, spawner, mockLogger);

      await manager.start({
        conversationId: 'conv-1',
        workingDirectory: 'primary',
      });

      await expect(
        manager.start({
          conversationId: 'conv-2',
          workingDirectory: 'primary',
        }),
      ).rejects.toMatchObject({ statusCode: 429 });
    });

    it('rejects invalid workspace ID with 400', async () => {
      await expect(
        manager.start({
          conversationId: 'conv-1',
          workingDirectory: 'nonexistent',
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('sendMessage', () => {
    it('writes message to stdin', async () => {
      await manager.start({
        conversationId: 'conv-1',
        workingDirectory: 'primary',
      });

      await manager.sendMessage('conv-1', 'Hello, Claude!');

      expect(proc.stdin.write).toHaveBeenCalledWith('Hello, Claude!\n');
    });

    it('rejects for unknown conversation with 404', async () => {
      await expect(
        manager.sendMessage('nonexistent', 'hello'),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('rejects for non-active conversation with 409', async () => {
      await manager.start({
        conversationId: 'conv-1',
        workingDirectory: 'primary',
      });

      // End the conversation to change state
      const endPromise = manager.end('conv-1');
      proc.resolveExit(0);
      await endPromise;

      await expect(
        manager.sendMessage('conv-1', 'hello'),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('end', () => {
    it('ends a conversation gracefully', async () => {
      await manager.start({
        conversationId: 'conv-1',
        workingDirectory: 'primary',
      });

      const endPromise = manager.end('conv-1');
      proc.resolveExit(0);
      const info = await endPromise;

      expect(info.state).toBe('ended');
      expect(proc.stdin.end).toHaveBeenCalled();
      expect(spawner.gracefulKill).toHaveBeenCalled();
    });

    it('rejects for unknown conversation with 404', async () => {
      await expect(
        manager.end('nonexistent'),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('removes conversation from active map after end', async () => {
      await manager.start({
        conversationId: 'conv-1',
        workingDirectory: 'primary',
      });

      const endPromise = manager.end('conv-1');
      proc.resolveExit(0);
      await endPromise;

      expect(manager.list()).toHaveLength(0);
    });
  });

  describe('list', () => {
    it('returns all active conversations', async () => {
      const proc2 = createMockProcessHandle();
      const spawnerMulti = {
        spawn: vi.fn()
          .mockReturnValueOnce(proc.handle)
          .mockReturnValueOnce(proc2.handle),
        gracefulKill: vi.fn(),
      } as unknown as ConversationSpawner;
      manager = new ConversationManager(config, spawnerMulti, mockLogger);

      await manager.start({ conversationId: 'conv-1', workingDirectory: 'primary' });
      await manager.start({ conversationId: 'conv-2', workingDirectory: 'dev' });

      const list = manager.list();
      expect(list).toHaveLength(2);
      expect(list.map((c) => c.conversationId).sort()).toEqual(['conv-1', 'conv-2']);
    });
  });

  describe('stop (shutdown)', () => {
    it('ends all active conversations', async () => {
      const proc2 = createMockProcessHandle();
      const spawnerMulti = {
        spawn: vi.fn()
          .mockReturnValueOnce(proc.handle)
          .mockReturnValueOnce(proc2.handle),
        gracefulKill: vi.fn((h: ChildProcessHandle) => h.kill('SIGTERM')),
      } as unknown as ConversationSpawner;
      manager = new ConversationManager(config, spawnerMulti, mockLogger);

      await manager.start({ conversationId: 'conv-1', workingDirectory: 'primary' });
      await manager.start({ conversationId: 'conv-2', workingDirectory: 'dev' });

      const stopPromise = manager.stop();
      proc.resolveExit(0);
      proc2.resolveExit(0);
      await stopPromise;

      expect(manager.list()).toHaveLength(0);
    });
  });

  describe('unexpected process exit', () => {
    it('emits error event and removes conversation', async () => {
      const outputEvents: { id: string; event: ConversationOutputEvent }[] = [];
      manager.setOutputCallback((id, event) => {
        outputEvents.push({ id, event });
      });

      await manager.start({
        conversationId: 'conv-1',
        workingDirectory: 'primary',
      });

      // Simulate unexpected exit
      proc.resolveExit(137);

      // Give event loop time to process the exit handler
      await new Promise((r) => setTimeout(r, 10));

      expect(manager.list()).toHaveLength(0);
      const errorEvent = outputEvents.find((e) => e.event.event === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.event.payload).toEqual(
        expect.objectContaining({ message: 'Process exited', exitCode: 137 }),
      );
    });
  });

  describe('output callback', () => {
    it('forwards parsed output events to callback', async () => {
      const outputEvents: { id: string; event: ConversationOutputEvent }[] = [];
      manager.setOutputCallback((id, event) => {
        outputEvents.push({ id, event });
      });

      await manager.start({
        conversationId: 'conv-1',
        workingDirectory: 'primary',
      });

      // Simulate CLI stdout
      proc.stdout.emit('data', '{"type":"text","text":"Hello!"}\n');

      expect(outputEvents).toHaveLength(1);
      expect(outputEvents[0].id).toBe('conv-1');
      expect(outputEvents[0].event.event).toBe('output');
      expect(outputEvents[0].event.payload).toEqual({ text: 'Hello!' });
    });
  });
});
