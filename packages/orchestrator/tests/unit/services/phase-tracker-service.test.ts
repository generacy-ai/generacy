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

  // #892: raw-key passthroughs — namespace regression guard.
  // BaseAdvanceMonitorService uses caller-owned `base-advance-tracker:` keys
  // outside the phase-tracker: namespace. The raw variants MUST pass the key
  // through untouched (no prefix injection) and mirror the semantics of the
  // phase-namespaced calls.
  describe('raw-key passthroughs (#892)', () => {
    it('isDuplicateRaw uses caller-owned key without prefix', async () => {
      const redis = createMockRedis({ exists: vi.fn().mockResolvedValue(1) });
      const tracker = new PhaseTrackerService(logger, redis);

      const key = 'base-advance-tracker:acme:widgets:42:abcdef0123456789abcdef0123456789abcdef01';
      const result = await tracker.isDuplicateRaw(key);

      expect(result).toBe(true);
      expect(redis.exists).toHaveBeenCalledWith(key);
    });

    it('markProcessedRaw uses caller-owned key with TTL', async () => {
      const redis = createMockRedis();
      const tracker = new PhaseTrackerService(logger, redis);

      const key = 'base-advance-tracker:acme:widgets:42:abcdef0123456789abcdef0123456789abcdef01';
      await tracker.markProcessedRaw(key);

      expect(redis.set).toHaveBeenCalledWith(key, '1', 'EX', 86400);
    });

    it('isDuplicateRaw behaves identically to phase-namespaced isDuplicate', async () => {
      // With a matching pre-built key, the two entrypoints must return the
      // same value from the same underlying Redis EXISTS call.
      const redis = createMockRedis({ exists: vi.fn().mockResolvedValue(1) });
      const tracker = new PhaseTrackerService(logger, redis);

      const rawKey = 'phase-tracker:owner:repo:42:validate-fix:abc123';
      await tracker.isDuplicateRaw(rawKey);
      await tracker.isDuplicate('owner', 'repo', 42, 'validate-fix:abc123');

      // Both calls hit EXISTS with the same reconstructed key.
      expect(redis.exists).toHaveBeenNthCalledWith(1, rawKey);
      expect(redis.exists).toHaveBeenNthCalledWith(2, rawKey);
    });

    it('raw variants gracefully degrade when Redis is null', async () => {
      const tracker = new PhaseTrackerService(logger, null);

      await expect(tracker.isDuplicateRaw('any-key')).resolves.toBe(false);
      await tracker.markProcessedRaw('any-key');

      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // #849 (paired resume-dedupe clear): backstop-of-the-backstop guard.
  // LabelManager.onGateHit clears the paired `resume:<gate>` dedupe at pause
  // time; this test asserts the underlying `clear()` behavior is sound.
  describe('clear', () => {
    it('clear() then isDuplicate() returns false', async () => {
      // Simulate the two states: pre-clear (exists:1 → duplicate) and
      // post-clear (exists:0 → not duplicate). One mock, two return values,
      // avoids pulling in ioredis-mock just for this case.
      const redis = createMockRedis({
        exists: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0),
        del: vi.fn().mockResolvedValue(1),
      });
      const tracker = new PhaseTrackerService(logger, redis);

      await expect(
        tracker.isDuplicate('owner', 'repo', 42, 'resume:implementation-review'),
      ).resolves.toBe(true);

      await tracker.clear('owner', 'repo', 42, 'resume:implementation-review');

      expect(redis.del).toHaveBeenCalledWith(
        'phase-tracker:owner:repo:42:resume:implementation-review',
      );

      await expect(
        tracker.isDuplicate('owner', 'repo', 42, 'resume:implementation-review'),
      ).resolves.toBe(false);
    });
  });
});
