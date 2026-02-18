import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PhaseTrackerService } from '../../../src/services/phase-tracker-service.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    exists: vi.fn().mockResolvedValue(0),
    set: vi.fn().mockResolvedValue('OK'),
    ...overrides,
  } as unknown as import('ioredis').Redis;
}

describe('PhaseTrackerService', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  describe('isDuplicate', () => {
    it('should return false when key does not exist', async () => {
      const redis = createMockRedis({ exists: vi.fn().mockResolvedValue(0) });
      const tracker = new PhaseTrackerService(logger, redis);

      const result = await tracker.isDuplicate('owner', 'repo', 42, 'speckit-feature');

      expect(result).toBe(false);
      expect(redis.exists).toHaveBeenCalledWith('phase-tracker:owner:repo:42:speckit-feature');
    });

    it('should return true when key exists', async () => {
      const redis = createMockRedis({ exists: vi.fn().mockResolvedValue(1) });
      const tracker = new PhaseTrackerService(logger, redis);

      const result = await tracker.isDuplicate('owner', 'repo', 42, 'speckit-feature');

      expect(result).toBe(true);
      expect(logger.info).toHaveBeenCalled();
    });

    it('should gracefully degrade when Redis is unavailable (null)', async () => {
      const tracker = new PhaseTrackerService(logger, null);

      const result = await tracker.isDuplicate('owner', 'repo', 42, 'speckit-feature');

      expect(result).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        'Redis unavailable for phase tracker, treating as not duplicate'
      );
    });

    it('should gracefully degrade on Redis error', async () => {
      const redis = createMockRedis({
        exists: vi.fn().mockRejectedValue(new Error('Connection refused')),
      });
      const tracker = new PhaseTrackerService(logger, redis);

      const result = await tracker.isDuplicate('owner', 'repo', 42, 'speckit-feature');

      expect(result).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('markProcessed', () => {
    it('should set key with TTL', async () => {
      const redis = createMockRedis();
      const tracker = new PhaseTrackerService(logger, redis);

      await tracker.markProcessed('owner', 'repo', 42, 'speckit-feature');

      expect(redis.set).toHaveBeenCalledWith(
        'phase-tracker:owner:repo:42:speckit-feature',
        '1',
        'EX',
        86400
      );
    });

    it('should use custom TTL', async () => {
      const redis = createMockRedis();
      const tracker = new PhaseTrackerService(logger, redis, { ttlSeconds: 3600 });

      await tracker.markProcessed('owner', 'repo', 42, 'speckit-feature');

      expect(redis.set).toHaveBeenCalledWith(
        'phase-tracker:owner:repo:42:speckit-feature',
        '1',
        'EX',
        3600
      );
    });

    it('should gracefully degrade when Redis is unavailable (null)', async () => {
      const tracker = new PhaseTrackerService(logger, null);

      await tracker.markProcessed('owner', 'repo', 42, 'speckit-feature');

      expect(logger.warn).toHaveBeenCalledWith(
        'Redis unavailable for phase tracker, skipping markProcessed'
      );
    });

    it('should gracefully degrade on Redis error', async () => {
      const redis = createMockRedis({
        set: vi.fn().mockRejectedValue(new Error('Connection refused')),
      });
      const tracker = new PhaseTrackerService(logger, redis);

      await tracker.markProcessed('owner', 'repo', 42, 'speckit-feature');

      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('key format', () => {
    it('should produce correct key format', async () => {
      const redis = createMockRedis();
      const tracker = new PhaseTrackerService(logger, redis);

      await tracker.isDuplicate('generacy-ai', 'generacy', 196, 'speckit-feature');

      expect(redis.exists).toHaveBeenCalledWith(
        'phase-tracker:generacy-ai:generacy:196:speckit-feature'
      );
    });
  });
});
