/**
 * HealthServer - HTTP health check endpoints for Kubernetes probes and monitoring.
 */

import type { HealthConfig, HealthResponse } from '../types.js';

/**
 * Interface for providing health status information.
 */
export interface HealthStatusProvider {
  /** Check if the worker is healthy */
  isHealthy(): boolean;
  /** Get current number of jobs being processed */
  getCurrentJobCount(): number;
  /** Get timestamp of last completed job */
  getLastCompletedTime(): string | null;
  /** Get Redis connection status */
  getRedisStatus(): 'connected' | 'disconnected';
  /** Get current queue depth */
  getQueueDepth(): number;
}

// Types for Express-like request/response
interface Request {
  path: string;
  method: string;
}

interface Response {
  status(code: number): Response;
  json(data: unknown): Response;
}

interface Server {
  close(callback?: () => void): void;
}

interface Express {
  get(path: string, handler: (req: Request, res: Response) => void): void;
  listen(port: number, callback?: () => void): Server;
}

/**
 * HealthServer provides HTTP endpoints for health checks.
 */
export class HealthServer {
  private provider: HealthStatusProvider;
  private config: HealthConfig;
  private server: Server | null = null;
  private startTime: number = Date.now();
  private version: string = '1.0.0';

  constructor(provider: HealthStatusProvider, config: HealthConfig) {
    this.provider = provider;
    this.config = config;
  }

  /**
   * Start the health server on the configured port.
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    // Import express dynamically
    const express = (await import('express')).default;
    const app: Express = express();

    // Register routes
    app.get('/health', this.handleHealth.bind(this));
    app.get('/health/live', this.handleLiveness.bind(this));
    app.get('/health/ready', this.handleReadiness.bind(this));

    // Start server
    return new Promise((resolve) => {
      this.server = app.listen(this.config.port, () => {
        this.startTime = Date.now();
        resolve();
      });
    });
  }

  /**
   * Stop the health server gracefully.
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Check if the server is running.
   */
  isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Get the configured port.
   */
  getPort(): number {
    return this.config.port;
  }

  /**
   * Handle full health check request.
   */
  private handleHealth(_req: Request, res: Response): void {
    const response = this.buildHealthResponse();
    const statusCode = response.status === 'unhealthy' ? 503 : 200;
    res.status(statusCode).json(response);
  }

  /**
   * Handle liveness probe.
   * Returns 200 if the process is running.
   */
  private handleLiveness(_req: Request, res: Response): void {
    res.status(200).json({ status: 'ok' });
  }

  /**
   * Handle readiness probe.
   * Returns 200 if Redis is connected, 503 otherwise.
   */
  private handleReadiness(_req: Request, res: Response): void {
    const redisStatus = this.provider.getRedisStatus();
    if (redisStatus === 'connected') {
      res.status(200).json({ status: 'ready' });
    } else {
      res.status(503).json({ status: 'not ready', reason: 'Redis disconnected' });
    }
  }

  /**
   * Build the full health response.
   */
  private buildHealthResponse(): HealthResponse {
    const isHealthy = this.provider.isHealthy();
    const redisStatus = this.provider.getRedisStatus();
    const currentJobs = this.provider.getCurrentJobCount();

    // Calculate status
    let status: HealthResponse['status'];
    if (!isHealthy || redisStatus === 'disconnected') {
      status = 'unhealthy';
    } else if (currentJobs > 10) {
      // High load indicates degraded state
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    return {
      status,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      currentJobs,
      lastJobCompleted: this.provider.getLastCompletedTime(),
      version: this.version,
      details: {
        redis: redisStatus,
        queueDepth: this.provider.getQueueDepth(),
      },
    };
  }
}
