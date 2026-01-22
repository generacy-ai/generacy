/**
 * Tests for extension logger
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger, LogLevel } from '../logger';

// Mock VS Code API
vi.mock('vscode', () => {
  const mockOutputChannel = {
    appendLine: vi.fn(),
    show: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
  };

  return {
    window: {
      createOutputChannel: vi.fn().mockReturnValue(mockOutputChannel),
    },
  };
});

describe('Logger', () => {
  let logger: Logger;

  beforeEach(() => {
    Logger.resetInstance();
    logger = Logger.getInstance();
    vi.clearAllMocks();
  });

  afterEach(() => {
    Logger.resetInstance();
  });

  describe('getInstance', () => {
    it('should return the same instance', () => {
      const instance1 = Logger.getInstance();
      const instance2 = Logger.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('setLevel and getLevel', () => {
    it('should set and get the log level', () => {
      logger.setLevel(LogLevel.Debug);
      expect(logger.getLevel()).toBe(LogLevel.Debug);

      logger.setLevel(LogLevel.Error);
      expect(logger.getLevel()).toBe(LogLevel.Error);
    });
  });

  describe('log methods', () => {
    it('should have debug, info, warn, and error methods', () => {
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
    });

    it('should filter logs below minimum level', () => {
      logger.setLevel(LogLevel.Error);
      const consoleSpy = vi.spyOn(console, 'debug');

      logger.debug('This should not be logged');
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should pass logs at or above minimum level', () => {
      logger.setLevel(LogLevel.Info);
      const consoleSpy = vi.spyOn(console, 'info');

      logger.info('This should be logged');
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('error logging', () => {
    it('should handle Error objects', () => {
      const consoleSpy = vi.spyOn(console, 'error');
      const testError = new Error('Test error message');

      logger.error('An error occurred', testError);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should handle non-Error values', () => {
      const consoleSpy = vi.spyOn(console, 'error');

      logger.error('An error occurred', 'string error');
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('createChild', () => {
    it('should create a child logger with prefix', () => {
      const child = logger.createChild('TestModule');
      expect(child).toBeDefined();
    });

    it('should prefix messages from child logger', () => {
      logger.setLevel(LogLevel.Debug);
      const child = logger.createChild('TestModule');
      const consoleSpy = vi.spyOn(console, 'info');

      child.info('Test message');
      expect(consoleSpy).toHaveBeenCalled();
      const callArg = consoleSpy.mock.calls[0]?.[0];
      expect(callArg).toContain('[TestModule]');

      consoleSpy.mockRestore();
    });
  });

  describe('show and clear', () => {
    it('should have show method', () => {
      expect(typeof logger.show).toBe('function');
      logger.show(); // Should not throw
    });

    it('should have clear method', () => {
      expect(typeof logger.clear).toBe('function');
      logger.clear(); // Should not throw
    });
  });
});

describe('LogLevel', () => {
  it('should have correct ordering', () => {
    expect(LogLevel.Debug).toBeLessThan(LogLevel.Info);
    expect(LogLevel.Info).toBeLessThan(LogLevel.Warn);
    expect(LogLevel.Warn).toBeLessThan(LogLevel.Error);
  });
});
