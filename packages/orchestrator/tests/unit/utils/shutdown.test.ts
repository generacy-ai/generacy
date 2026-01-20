import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  setupGracefulShutdown,
  isShuttingDown,
  resetShutdownState,
} from '../../../src/utils/shutdown.js';

describe('shutdown', () => {
  let mockServer: FastifyInstance;
  let processOnSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetShutdownState();
    mockServer = {
      close: vi.fn().mockResolvedValue(undefined),
      log: {
        info: vi.fn(),
        error: vi.fn(),
      },
    } as unknown as FastifyInstance;

    processOnSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
    resetShutdownState();
  });

  describe('setupGracefulShutdown', () => {
    it('should register SIGTERM and SIGINT handlers', () => {
      setupGracefulShutdown(mockServer);

      expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
      expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    });

    it('should return a shutdown function', () => {
      const shutdown = setupGracefulShutdown(mockServer);
      expect(typeof shutdown).toBe('function');
    });

    it('should close server when shutdown is called', async () => {
      const shutdown = setupGracefulShutdown(mockServer);
      await shutdown();
      expect(mockServer.close).toHaveBeenCalled();
    });

    it('should run cleanup functions', async () => {
      const cleanup1 = vi.fn().mockResolvedValue(undefined);
      const cleanup2 = vi.fn().mockResolvedValue(undefined);

      const shutdown = setupGracefulShutdown(mockServer, {
        cleanup: [cleanup1, cleanup2],
      });

      await shutdown();

      expect(cleanup1).toHaveBeenCalled();
      expect(cleanup2).toHaveBeenCalled();
    });

    it('should continue cleanup even if one fails', async () => {
      const cleanup1 = vi.fn().mockRejectedValue(new Error('cleanup error'));
      const cleanup2 = vi.fn().mockResolvedValue(undefined);
      const logger = {
        info: vi.fn(),
        error: vi.fn(),
      };

      const shutdown = setupGracefulShutdown(mockServer, {
        cleanup: [cleanup1, cleanup2],
        logger,
      });

      await shutdown();

      expect(cleanup1).toHaveBeenCalled();
      expect(cleanup2).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('isShuttingDown', () => {
    it('should return false initially', () => {
      expect(isShuttingDown()).toBe(false);
    });

    it('should return true after shutdown is initiated', async () => {
      const shutdown = setupGracefulShutdown(mockServer);
      const shutdownPromise = shutdown();
      expect(isShuttingDown()).toBe(true);
      await shutdownPromise;
    });
  });

  describe('resetShutdownState', () => {
    it('should reset shutdown state', async () => {
      const shutdown = setupGracefulShutdown(mockServer);
      await shutdown();
      expect(isShuttingDown()).toBe(true);

      resetShutdownState();
      expect(isShuttingDown()).toBe(false);
    });
  });

  describe('signal handling', () => {
    it('should ignore duplicate signals', async () => {
      const logger = {
        info: vi.fn(),
        error: vi.fn(),
      };

      setupGracefulShutdown(mockServer, { logger });

      // Get the SIGTERM handler
      const sigtermHandler = processOnSpy.mock.calls.find(
        (call) => call[0] === 'SIGTERM'
      )?.[1] as () => void;

      expect(sigtermHandler).toBeDefined();

      // Call it twice
      sigtermHandler();
      sigtermHandler();

      // Server.close should only be called once
      // Give time for the async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockServer.close).toHaveBeenCalledTimes(1);
    });
  });
});
