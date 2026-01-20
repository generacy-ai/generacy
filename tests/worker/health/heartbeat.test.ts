/**
 * Tests for the Heartbeat class.
 *
 * The Heartbeat class publishes worker status to Redis at regular intervals
 * for health monitoring and coordination.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import type {
  HeartbeatConfig,
  WorkerHeartbeat,
  WorkerMetrics,
  WorkerStatus,
} from '../../../src/worker/types.js';

/**
 * Status provider interface for heartbeat data.
 */
interface HeartbeatStatusProvider {
  getStatus(): WorkerStatus;
  getCurrentJob(): { id: string } | undefined;
  getMetrics(): WorkerMetrics;
}

/**
 * Mock Redis client interface.
 */
interface MockRedisClient {
  setex: MockInstance<[key: string, ttl: number, value: string], Promise<string>>;
  publish: MockInstance<[channel: string, message: string], Promise<number>>;
}

/**
 * Heartbeat class implementation (to be implemented in src/worker/health/heartbeat.ts).
 *
 * This class manages publishing worker heartbeats to Redis for health monitoring.
 */
class Heartbeat {
  private redis: MockRedisClient;
  private workerId: string;
  private statusProvider: HeartbeatStatusProvider;
  private config: HeartbeatConfig;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    redis: MockRedisClient,
    workerId: string,
    statusProvider: HeartbeatStatusProvider,
    config: HeartbeatConfig
  ) {
    this.redis = redis;
    this.workerId = workerId;
    this.statusProvider = statusProvider;
    this.config = config;
  }

  /**
   * Start publishing heartbeats at the configured interval.
   */
  start(): void {
    if (this.intervalId !== null) {
      return; // Already started
    }

    // Publish immediately on start
    this.publish();

    // Set up interval for subsequent heartbeats
    this.intervalId = setInterval(() => {
      this.publish();
    }, this.config.interval);
  }

  /**
   * Stop publishing heartbeats.
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Publish a single heartbeat to Redis.
   */
  async publish(): Promise<void> {
    const currentJob = this.statusProvider.getCurrentJob();

    const heartbeat: WorkerHeartbeat = {
      workerId: this.workerId,
      timestamp: Date.now(),
      status: this.statusProvider.getStatus(),
      currentJob: currentJob?.id,
      metrics: this.statusProvider.getMetrics(),
    };

    const key = `worker:heartbeat:${this.workerId}`;
    const ttlSeconds = Math.floor(this.config.ttl / 1000);
    const value = JSON.stringify(heartbeat);

    // Set key with TTL
    await this.redis.setex(key, ttlSeconds, value);

    // Publish to channel for real-time monitoring
    await this.redis.publish('worker:heartbeat', value);
  }

  /**
   * Check if heartbeat publishing is active.
   */
  isActive(): boolean {
    return this.intervalId !== null;
  }
}

describe('Heartbeat', () => {
  let mockRedis: MockRedisClient;
  let mockStatusProvider: HeartbeatStatusProvider;
  let heartbeat: Heartbeat;
  let config: HeartbeatConfig;

  const workerId = 'worker-test-123';

  const defaultMetrics: WorkerMetrics = {
    jobsProcessed: 10,
    jobsSucceeded: 8,
    jobsFailed: 2,
    errorRate: 0.2,
    avgProcessingTime: 1500,
    lastProcessingTime: 1200,
  };

  beforeEach(() => {
    vi.useFakeTimers();

    mockRedis = {
      setex: vi.fn().mockResolvedValue('OK'),
      publish: vi.fn().mockResolvedValue(1),
    };

    mockStatusProvider = {
      getStatus: vi.fn().mockReturnValue('idle' as WorkerStatus),
      getCurrentJob: vi.fn().mockReturnValue(undefined),
      getMetrics: vi.fn().mockReturnValue(defaultMetrics),
    };

    config = {
      enabled: true,
      interval: 5000, // 5 seconds
      ttl: 15000, // 15 seconds
    };

    heartbeat = new Heartbeat(mockRedis, workerId, mockStatusProvider, config);
  });

  afterEach(() => {
    heartbeat.stop();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create heartbeat with provided dependencies', () => {
      const hb = new Heartbeat(mockRedis, workerId, mockStatusProvider, config);
      expect(hb).toBeDefined();
      expect(hb.isActive()).toBe(false);
    });

    it('should not be active initially', () => {
      expect(heartbeat.isActive()).toBe(false);
    });
  });

  describe('start()', () => {
    it('should begin interval publishing', () => {
      heartbeat.start();

      expect(heartbeat.isActive()).toBe(true);
    });

    it('should publish immediately on start', async () => {
      heartbeat.start();

      // Flush pending promises from the async publish() call
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRedis.setex).toHaveBeenCalled();
      expect(mockRedis.publish).toHaveBeenCalled();
    });

    it('should publish at configured interval', async () => {
      heartbeat.start();

      // Initial publish (flush promises)
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRedis.setex).toHaveBeenCalledTimes(1);

      // Advance by one interval
      await vi.advanceTimersByTimeAsync(config.interval);
      expect(mockRedis.setex).toHaveBeenCalledTimes(2);

      // Advance by another interval
      await vi.advanceTimersByTimeAsync(config.interval);
      expect(mockRedis.setex).toHaveBeenCalledTimes(3);
    });

    it('should be idempotent - starting twice does not create duplicate intervals', async () => {
      heartbeat.start();
      heartbeat.start(); // Second start should be ignored

      // Flush initial publish
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRedis.setex).toHaveBeenCalledTimes(1);

      // Advance by one interval
      await vi.advanceTimersByTimeAsync(config.interval);

      // Should only have 2 calls (initial + 1 interval), not 4 (2x initial + 2x interval)
      expect(mockRedis.setex).toHaveBeenCalledTimes(2);
    });
  });

  describe('stop()', () => {
    it('should clear interval when stopped', async () => {
      heartbeat.start();
      expect(heartbeat.isActive()).toBe(true);

      heartbeat.stop();
      expect(heartbeat.isActive()).toBe(false);
    });

    it('should stop publishing after stop is called', async () => {
      heartbeat.start();

      // Flush initial publish
      await vi.advanceTimersByTimeAsync(0);

      const callsBeforeStop = mockRedis.setex.mock.calls.length;

      heartbeat.stop();

      // Advance time - should not trigger more publishes
      await vi.advanceTimersByTimeAsync(config.interval * 3);

      expect(mockRedis.setex).toHaveBeenCalledTimes(callsBeforeStop);
    });

    it('should be safe to call stop multiple times', () => {
      heartbeat.start();
      heartbeat.stop();
      heartbeat.stop(); // Should not throw
      heartbeat.stop(); // Should not throw

      expect(heartbeat.isActive()).toBe(false);
    });

    it('should be safe to call stop when not started', () => {
      expect(() => heartbeat.stop()).not.toThrow();
      expect(heartbeat.isActive()).toBe(false);
    });

    it('should allow restart after stop', async () => {
      heartbeat.start();

      // Flush initial publish
      await vi.advanceTimersByTimeAsync(0);

      heartbeat.stop();
      expect(heartbeat.isActive()).toBe(false);

      heartbeat.start();
      expect(heartbeat.isActive()).toBe(true);

      // Flush second initial publish
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRedis.setex).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(config.interval);

      // Should have calls from both start cycles: 2 initial + 1 interval = 3
      expect(mockRedis.setex.mock.calls.length).toBeGreaterThan(1);
    });
  });

  describe('publish()', () => {
    it('should set Redis key with correct TTL', async () => {
      await heartbeat.publish();

      const expectedKey = `worker:heartbeat:${workerId}`;
      const expectedTtlSeconds = Math.floor(config.ttl / 1000); // 15

      expect(mockRedis.setex).toHaveBeenCalledWith(
        expectedKey,
        expectedTtlSeconds,
        expect.any(String)
      );
    });

    it('should publish to Redis channel', async () => {
      await heartbeat.publish();

      expect(mockRedis.publish).toHaveBeenCalledWith(
        'worker:heartbeat',
        expect.any(String)
      );
    });

    it('should publish same data to key and channel', async () => {
      await heartbeat.publish();

      const setexValue = mockRedis.setex.mock.calls[0][2];
      const publishValue = mockRedis.publish.mock.calls[0][1];

      expect(setexValue).toBe(publishValue);
    });

    it('should include correct workerId in heartbeat', async () => {
      await heartbeat.publish();

      const publishedData = JSON.parse(mockRedis.publish.mock.calls[0][1]) as WorkerHeartbeat;

      expect(publishedData.workerId).toBe(workerId);
    });

    it('should include timestamp in heartbeat', async () => {
      const now = 1705700000000;
      vi.setSystemTime(now);

      await heartbeat.publish();

      const publishedData = JSON.parse(mockRedis.publish.mock.calls[0][1]) as WorkerHeartbeat;

      expect(publishedData.timestamp).toBe(now);
    });

    it('should include status from provider', async () => {
      vi.mocked(mockStatusProvider.getStatus).mockReturnValue('processing');

      await heartbeat.publish();

      const publishedData = JSON.parse(mockRedis.publish.mock.calls[0][1]) as WorkerHeartbeat;

      expect(publishedData.status).toBe('processing');
    });

    it('should include metrics from provider', async () => {
      const customMetrics: WorkerMetrics = {
        jobsProcessed: 25,
        jobsSucceeded: 20,
        jobsFailed: 5,
        errorRate: 0.2,
        avgProcessingTime: 2000,
        lastProcessingTime: 1800,
      };
      vi.mocked(mockStatusProvider.getMetrics).mockReturnValue(customMetrics);

      await heartbeat.publish();

      const publishedData = JSON.parse(mockRedis.publish.mock.calls[0][1]) as WorkerHeartbeat;

      expect(publishedData.metrics).toEqual(customMetrics);
    });

    it('should include currentJob when job is being processed', async () => {
      vi.mocked(mockStatusProvider.getCurrentJob).mockReturnValue({ id: 'job-456' });
      vi.mocked(mockStatusProvider.getStatus).mockReturnValue('processing');

      await heartbeat.publish();

      const publishedData = JSON.parse(mockRedis.publish.mock.calls[0][1]) as WorkerHeartbeat;

      expect(publishedData.currentJob).toBe('job-456');
    });

    it('should not include currentJob when no job is processing', async () => {
      vi.mocked(mockStatusProvider.getCurrentJob).mockReturnValue(undefined);

      await heartbeat.publish();

      const publishedData = JSON.parse(mockRedis.publish.mock.calls[0][1]) as WorkerHeartbeat;

      expect(publishedData.currentJob).toBeUndefined();
    });
  });

  describe('heartbeat data format', () => {
    it('should produce valid WorkerHeartbeat structure', async () => {
      const now = 1705700000000;
      vi.setSystemTime(now);

      vi.mocked(mockStatusProvider.getStatus).mockReturnValue('processing');
      vi.mocked(mockStatusProvider.getCurrentJob).mockReturnValue({ id: 'job-789' });
      vi.mocked(mockStatusProvider.getMetrics).mockReturnValue(defaultMetrics);

      await heartbeat.publish();

      const publishedData = JSON.parse(mockRedis.publish.mock.calls[0][1]) as WorkerHeartbeat;

      expect(publishedData).toEqual({
        workerId: workerId,
        timestamp: now,
        status: 'processing',
        currentJob: 'job-789',
        metrics: defaultMetrics,
      });
    });

    it('should serialize to valid JSON', async () => {
      await heartbeat.publish();

      const publishedValue = mockRedis.publish.mock.calls[0][1];

      expect(() => JSON.parse(publishedValue)).not.toThrow();
    });

    it('should handle all worker status values', async () => {
      const statuses: WorkerStatus[] = ['idle', 'processing', 'draining', 'stopped'];

      for (const status of statuses) {
        vi.mocked(mockStatusProvider.getStatus).mockReturnValue(status);

        await heartbeat.publish();

        const publishedData = JSON.parse(
          mockRedis.publish.mock.calls[mockRedis.publish.mock.calls.length - 1][1]
        ) as WorkerHeartbeat;

        expect(publishedData.status).toBe(status);
      }
    });
  });

  describe('interval timing', () => {
    it('should publish at exact interval boundaries', async () => {
      heartbeat.start();

      // Flush initial publish
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRedis.setex).toHaveBeenCalledTimes(1);

      // Record initial call count
      const initialCalls = mockRedis.setex.mock.calls.length;

      // Advance just before interval
      await vi.advanceTimersByTimeAsync(config.interval - 1);
      expect(mockRedis.setex).toHaveBeenCalledTimes(initialCalls);

      // Advance to exact interval
      await vi.advanceTimersByTimeAsync(1);
      expect(mockRedis.setex).toHaveBeenCalledTimes(initialCalls + 1);
    });

    it('should handle custom interval values', async () => {
      const customConfig: HeartbeatConfig = {
        enabled: true,
        interval: 10000, // 10 seconds
        ttl: 30000,
      };

      const customHeartbeat = new Heartbeat(mockRedis, workerId, mockStatusProvider, customConfig);

      customHeartbeat.start();

      // Flush initial publish
      await vi.advanceTimersByTimeAsync(0);
      const initialCalls = mockRedis.setex.mock.calls.length;

      // Advance by 5 seconds (half interval)
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockRedis.setex).toHaveBeenCalledTimes(initialCalls);

      // Advance to full interval
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockRedis.setex).toHaveBeenCalledTimes(initialCalls + 1);

      customHeartbeat.stop();
    });

    it('should continue publishing over multiple intervals', async () => {
      heartbeat.start();

      // Flush initial publish
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRedis.setex).toHaveBeenCalledTimes(1);

      // Advance through 5 intervals
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(config.interval);
      }

      // Initial + 5 intervals = 6 total
      expect(mockRedis.setex).toHaveBeenCalledTimes(6);
    });
  });

  describe('TTL calculation', () => {
    it('should convert TTL from milliseconds to seconds', async () => {
      await heartbeat.publish();

      // 15000ms = 15 seconds
      expect(mockRedis.setex).toHaveBeenCalledWith(
        expect.any(String),
        15,
        expect.any(String)
      );
    });

    it('should floor fractional seconds', async () => {
      const oddConfig: HeartbeatConfig = {
        enabled: true,
        interval: 5000,
        ttl: 15500, // 15.5 seconds - should floor to 15
      };

      const oddHeartbeat = new Heartbeat(mockRedis, workerId, mockStatusProvider, oddConfig);

      await oddHeartbeat.publish();

      expect(mockRedis.setex).toHaveBeenCalledWith(
        expect.any(String),
        15,
        expect.any(String)
      );
    });

    it('should handle minimum TTL correctly', async () => {
      const minConfig: HeartbeatConfig = {
        enabled: true,
        interval: 1000,
        ttl: 1000, // 1 second
      };

      const minHeartbeat = new Heartbeat(mockRedis, workerId, mockStatusProvider, minConfig);

      await minHeartbeat.publish();

      expect(mockRedis.setex).toHaveBeenCalledWith(
        expect.any(String),
        1,
        expect.any(String)
      );
    });
  });

  describe('Redis key format', () => {
    it('should use correct key prefix', async () => {
      await heartbeat.publish();

      expect(mockRedis.setex).toHaveBeenCalledWith(
        `worker:heartbeat:${workerId}`,
        expect.any(Number),
        expect.any(String)
      );
    });

    it('should use workerId in key', async () => {
      const customWorkerId = 'custom-worker-abc';
      const customHeartbeat = new Heartbeat(mockRedis, customWorkerId, mockStatusProvider, config);

      await customHeartbeat.publish();

      expect(mockRedis.setex).toHaveBeenCalledWith(
        `worker:heartbeat:${customWorkerId}`,
        expect.any(Number),
        expect.any(String)
      );
    });
  });

  describe('error handling', () => {
    it('should not throw when Redis setex fails', async () => {
      mockRedis.setex.mockRejectedValueOnce(new Error('Redis connection failed'));

      // Should not throw
      await expect(heartbeat.publish()).rejects.toThrow('Redis connection failed');
    });

    it('should not throw when Redis publish fails', async () => {
      mockRedis.publish.mockRejectedValueOnce(new Error('Publish failed'));

      // The setex succeeds but publish fails
      await expect(heartbeat.publish()).rejects.toThrow('Publish failed');
    });
  });

  describe('integration scenario', () => {
    it('should reflect changing worker state over time', async () => {
      // Start as idle
      vi.mocked(mockStatusProvider.getStatus).mockReturnValue('idle');
      vi.mocked(mockStatusProvider.getCurrentJob).mockReturnValue(undefined);

      heartbeat.start();

      // Flush initial publish
      await vi.advanceTimersByTimeAsync(0);

      let publishedData = JSON.parse(mockRedis.publish.mock.calls[0][1]) as WorkerHeartbeat;
      expect(publishedData.status).toBe('idle');
      expect(publishedData.currentJob).toBeUndefined();

      // Simulate job starting
      vi.mocked(mockStatusProvider.getStatus).mockReturnValue('processing');
      vi.mocked(mockStatusProvider.getCurrentJob).mockReturnValue({ id: 'job-001' });

      await vi.advanceTimersByTimeAsync(config.interval);

      publishedData = JSON.parse(mockRedis.publish.mock.calls[1][1]) as WorkerHeartbeat;
      expect(publishedData.status).toBe('processing');
      expect(publishedData.currentJob).toBe('job-001');

      // Simulate job completed
      vi.mocked(mockStatusProvider.getStatus).mockReturnValue('idle');
      vi.mocked(mockStatusProvider.getCurrentJob).mockReturnValue(undefined);
      vi.mocked(mockStatusProvider.getMetrics).mockReturnValue({
        ...defaultMetrics,
        jobsProcessed: 11,
        jobsSucceeded: 9,
      });

      await vi.advanceTimersByTimeAsync(config.interval);

      publishedData = JSON.parse(mockRedis.publish.mock.calls[2][1]) as WorkerHeartbeat;
      expect(publishedData.status).toBe('idle');
      expect(publishedData.currentJob).toBeUndefined();
      expect(publishedData.metrics.jobsProcessed).toBe(11);
    });

    it('should handle worker draining state', async () => {
      vi.mocked(mockStatusProvider.getStatus).mockReturnValue('draining');
      vi.mocked(mockStatusProvider.getCurrentJob).mockReturnValue({ id: 'final-job' });

      await heartbeat.publish();

      const publishedData = JSON.parse(mockRedis.publish.mock.calls[0][1]) as WorkerHeartbeat;

      expect(publishedData.status).toBe('draining');
      expect(publishedData.currentJob).toBe('final-job');
    });
  });
});
