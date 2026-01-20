/**
 * Unit tests for ContainerManager.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Logger } from 'pino';
import { ContainerManager } from '../../src/container/container-manager.js';
import { ContainerStartError, ContainerNotRunningError } from '../../src/errors.js';
import type { ContainerConfig } from '../../src/types.js';

// Mock Docker client
const createMockContainer = () => ({
  id: 'test-container-id',
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
  inspect: vi.fn().mockResolvedValue({
    State: {
      Running: true,
      ExitCode: 0,
      Health: {
        Status: 'healthy',
        FailingStreak: 0,
        Log: [],
      },
    },
  }),
  attach: vi.fn().mockResolvedValue({
    on: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  }),
  exec: vi.fn().mockResolvedValue({
    start: vi.fn().mockResolvedValue({
      on: vi.fn((event: string, callback: (data?: Buffer) => void) => {
        if (event === 'end') {
          setTimeout(() => callback(), 10);
        }
      }),
      destroy: vi.fn(),
    }),
    inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
  }),
});

const createMockDocker = (container = createMockContainer()) => ({
  createContainer: vi.fn().mockResolvedValue(container),
  getContainer: vi.fn().mockReturnValue(container),
});

const createMockLogger = (): Logger => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
}) as unknown as Logger;

const createTestConfig = (): ContainerConfig => ({
  image: 'test-image:latest',
  workdir: '/workspace',
  env: { TEST_VAR: 'test-value' },
  mounts: [{ source: '/host/path', target: '/container/path' }],
  network: 'test-network',
});

describe('ContainerManager', () => {
  let manager: ContainerManager;
  let mockDocker: ReturnType<typeof createMockDocker>;
  let mockLogger: Logger;

  beforeEach(() => {
    mockDocker = createMockDocker();
    mockLogger = createMockLogger();
    manager = new ContainerManager(mockDocker as any, mockLogger);
  });

  describe('create', () => {
    it('should create a container with the correct options', async () => {
      const config = createTestConfig();
      const sessionId = 'test-session';

      const result = await manager.create({ sessionId, config });

      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: config.image,
          WorkingDir: config.workdir,
          Env: ['TEST_VAR=test-value'],
          Labels: expect.objectContaining({
            'generacy.session.id': sessionId,
            'generacy.managed': 'true',
          }),
          HostConfig: expect.objectContaining({
            NetworkMode: config.network,
            Binds: ['/host/path:/container/path'],
          }),
        })
      );

      expect(result.containerId).toBe('test-container-id');
      expect(result.sessionId).toBe(sessionId);
      expect(result.state.status).toBe('created');
    });

    it('should handle resource limits', async () => {
      const config: ContainerConfig = {
        ...createTestConfig(),
        resources: {
          memory: 1073741824, // 1GB
          cpus: 2,
        },
      };

      await manager.create({ sessionId: 'test-session', config });

      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            Memory: 1073741824,
            NanoCpus: 2000000000,
          }),
        })
      );
    });

    it('should throw ContainerStartError on docker failure', async () => {
      mockDocker.createContainer.mockRejectedValue(new Error('Docker error'));

      await expect(
        manager.create({ sessionId: 'test-session', config: createTestConfig() })
      ).rejects.toThrow(ContainerStartError);
    });
  });

  describe('start', () => {
    it('should start a created container', async () => {
      const config = createTestConfig();
      await manager.create({ sessionId: 'test-session', config });

      const result = await manager.start('test-session');

      expect(result.state.status).toBe('running');
    });

    it('should throw ContainerNotRunningError for unknown session', async () => {
      await expect(manager.start('unknown-session')).rejects.toThrow(
        ContainerNotRunningError
      );
    });
  });

  describe('stop', () => {
    it('should stop a running container', async () => {
      const config = createTestConfig();
      await manager.create({ sessionId: 'test-session', config });
      await manager.start('test-session');

      await manager.stop('test-session');

      const state = manager.getState('test-session');
      expect(state?.status).toBe('stopped');
    });

    it('should not throw for unknown session', async () => {
      await expect(manager.stop('unknown-session')).resolves.not.toThrow();
    });

    it('should remove container when remove option is true', async () => {
      const container = createMockContainer();
      mockDocker = createMockDocker(container);
      manager = new ContainerManager(mockDocker as any, mockLogger);

      await manager.create({ sessionId: 'test-session', config: createTestConfig() });
      await manager.start('test-session');
      await manager.stop('test-session', { remove: true });

      expect(container.remove).toHaveBeenCalledWith({ force: true });
    });
  });

  describe('remove', () => {
    it('should remove a container', async () => {
      const container = createMockContainer();
      mockDocker = createMockDocker(container);
      manager = new ContainerManager(mockDocker as any, mockLogger);

      await manager.create({ sessionId: 'test-session', config: createTestConfig() });
      await manager.remove('test-session');

      expect(container.remove).toHaveBeenCalledWith({ force: true });
      expect(manager.hasContainer('test-session')).toBe(false);
    });

    it('should not throw for unknown session', async () => {
      await expect(manager.remove('unknown-session')).resolves.not.toThrow();
    });
  });

  describe('getContainer', () => {
    it('should return container info', async () => {
      await manager.create({ sessionId: 'test-session', config: createTestConfig() });

      const container = manager.getContainer('test-session');

      expect(container.sessionId).toBe('test-session');
      expect(container.containerId).toBe('test-container-id');
    });

    it('should throw ContainerNotRunningError for unknown session', () => {
      expect(() => manager.getContainer('unknown-session')).toThrow(
        ContainerNotRunningError
      );
    });
  });

  describe('hasContainer', () => {
    it('should return true for existing container', async () => {
      await manager.create({ sessionId: 'test-session', config: createTestConfig() });

      expect(manager.hasContainer('test-session')).toBe(true);
    });

    it('should return false for unknown session', () => {
      expect(manager.hasContainer('unknown-session')).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should stop and remove all containers', async () => {
      const container = createMockContainer();
      mockDocker = createMockDocker(container);
      manager = new ContainerManager(mockDocker as any, mockLogger);

      await manager.create({ sessionId: 'session-1', config: createTestConfig() });
      await manager.create({ sessionId: 'session-2', config: createTestConfig() });
      await manager.start('session-1');
      await manager.start('session-2');

      await manager.cleanup();

      expect(manager.hasContainer('session-1')).toBe(false);
      expect(manager.hasContainer('session-2')).toBe(false);
    });
  });

  describe('attach', () => {
    it('should attach to a running container', async () => {
      await manager.create({ sessionId: 'test-session', config: createTestConfig() });
      await manager.start('test-session');

      const streams = await manager.attach('test-session');

      expect(streams.stdin).toBeDefined();
      expect(streams.stdout).toBeDefined();
      expect(streams.stderr).toBeDefined();
    });

    it('should throw ContainerNotRunningError for non-running container', async () => {
      await manager.create({ sessionId: 'test-session', config: createTestConfig() });

      await expect(manager.attach('test-session')).rejects.toThrow(
        ContainerNotRunningError
      );
    });
  });

  describe('checkHealth', () => {
    it('should return health status for running container', async () => {
      await manager.create({ sessionId: 'test-session', config: createTestConfig() });
      await manager.start('test-session');

      const health = await manager.checkHealth('test-session');

      expect(health.status).toBe('healthy');
      expect(health.failureCount).toBe(0);
    });

    it('should return unknown for non-running container', async () => {
      await manager.create({ sessionId: 'test-session', config: createTestConfig() });

      const health = await manager.checkHealth('test-session');

      expect(health.status).toBe('unknown');
    });
  });
});
