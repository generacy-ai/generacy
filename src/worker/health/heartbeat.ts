/**
 * Heartbeat - Publishes worker status to Redis for health monitoring.
 */

import type {
  HeartbeatConfig,
  WorkerHeartbeat,
  WorkerMetrics,
  WorkerStatus,
} from '../types.js';

/**
 * Status provider interface for heartbeat data.
 */
export interface HeartbeatStatusProvider {
  getStatus(): WorkerStatus;
  getCurrentJob(): { id: string } | undefined;
  getMetrics(): WorkerMetrics;
}

/**
 * Redis client interface for heartbeat operations.
 */
export interface RedisClient {
  setex(key: string, ttl: number, value: string): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
}

/**
 * Heartbeat class manages publishing worker heartbeats to Redis.
 */
export class Heartbeat {
  private redis: RedisClient;
  private workerId: string;
  private statusProvider: HeartbeatStatusProvider;
  private config: HeartbeatConfig;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    redis: RedisClient,
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
