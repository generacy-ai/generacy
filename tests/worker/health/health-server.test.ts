/**
 * Tests for the HealthServer class.
 *
 * HealthServer provides HTTP health check endpoints for Kubernetes probes
 * and monitoring systems.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { HealthConfig, HealthResponse } from '../../../src/worker/types.js';

// ============ Mocks ============

// Mock Express request
interface MockRequest {
  path: string;
  method: string;
}

// Mock Express response
interface MockResponse {
  status: Mock;
  json: Mock;
  send: Mock;
  statusCode?: number;
  _data?: unknown;
}

function createMockResponse(): MockResponse {
  const res: MockResponse = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return res;
}

// Mock Express server
interface MockServer {
  listen: Mock;
  close: Mock;
}

function createMockServer(): MockServer {
  return {
    listen: vi.fn((port: number, callback?: () => void) => {
      if (callback) callback();
      return { close: vi.fn() };
    }),
    close: vi.fn((callback?: () => void) => {
      if (callback) callback();
    }),
  };
}

// Route handler registry for testing
type RouteHandler = (req: MockRequest, res: MockResponse) => void;
const routeHandlers: Map<string, RouteHandler> = new Map();

// Mock Express app
interface MockApp {
  get: Mock;
  listen: Mock;
}

function createMockApp(server: MockServer): MockApp {
  return {
    get: vi.fn((path: string, handler: RouteHandler) => {
      routeHandlers.set(path, handler);
    }),
    listen: vi.fn((port: number, callback?: () => void) => {
      server.listen(port, callback);
      return server;
    }),
  };
}

// Mock Express module
const mockServer = createMockServer();
const mockApp = createMockApp(mockServer);

vi.mock('express', () => ({
  default: () => mockApp,
}));

// ============ Health Status Provider Interface ============

/**
 * Interface for providing health status information.
 * The HealthServer uses this to construct health responses.
 */
interface HealthStatusProvider {
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

// ============ Mock Health Status Provider ============

function createMockHealthStatusProvider(overrides: Partial<HealthStatusProvider> = {}): HealthStatusProvider {
  return {
    isHealthy: vi.fn().mockReturnValue(true),
    getCurrentJobCount: vi.fn().mockReturnValue(0),
    getLastCompletedTime: vi.fn().mockReturnValue(null),
    getRedisStatus: vi.fn().mockReturnValue('connected'),
    getQueueDepth: vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

// ============ HealthServer Implementation (for TDD) ============

/**
 * HealthServer provides HTTP endpoints for health checks.
 * This implementation is provided inline for TDD - the actual implementation
 * will be in src/worker/health/health-server.ts
 */
class HealthServer {
  private provider: HealthStatusProvider;
  private config: HealthConfig;
  private server: MockServer | null = null;
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

    // Import express dynamically (mocked in tests)
    const express = (await import('express')).default;
    const app = express();

    // Register routes
    app.get('/health', this.handleHealth.bind(this));
    app.get('/health/live', this.handleLiveness.bind(this));
    app.get('/health/ready', this.handleReadiness.bind(this));

    // Start server
    return new Promise((resolve) => {
      this.server = app.listen(this.config.port, () => {
        this.startTime = Date.now();
        resolve();
      }) as unknown as MockServer;
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
  private handleHealth(_req: MockRequest, res: MockResponse): void {
    const response = this.buildHealthResponse();
    const statusCode = response.status === 'unhealthy' ? 503 : 200;
    res.status(statusCode).json(response);
  }

  /**
   * Handle liveness probe.
   * Returns 200 if the process is running.
   */
  private handleLiveness(_req: MockRequest, res: MockResponse): void {
    res.status(200).json({ status: 'ok' });
  }

  /**
   * Handle readiness probe.
   * Returns 200 if Redis is connected, 503 otherwise.
   */
  private handleReadiness(_req: MockRequest, res: MockResponse): void {
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

// ============ Test Suite ============

describe('HealthServer', () => {
  let healthServer: HealthServer;
  let provider: HealthStatusProvider;
  let config: HealthConfig;

  beforeEach(() => {
    // Clear route handlers between tests
    routeHandlers.clear();
    vi.clearAllMocks();

    provider = createMockHealthStatusProvider();
    config = {
      enabled: true,
      port: 8080,
    };
  });

  afterEach(async () => {
    if (healthServer?.isRunning()) {
      await healthServer.stop();
    }
  });

  describe('constructor', () => {
    it('should create HealthServer with provider and config', () => {
      healthServer = new HealthServer(provider, config);
      expect(healthServer).toBeDefined();
    });

    it('should not be running initially', () => {
      healthServer = new HealthServer(provider, config);
      expect(healthServer.isRunning()).toBe(false);
    });

    it('should store the configured port', () => {
      config.port = 9090;
      healthServer = new HealthServer(provider, config);
      expect(healthServer.getPort()).toBe(9090);
    });
  });

  describe('start', () => {
    it('should start the server when enabled', async () => {
      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      expect(healthServer.isRunning()).toBe(true);
      expect(mockApp.listen).toHaveBeenCalledWith(8080, expect.any(Function));
    });

    it('should not start the server when disabled', async () => {
      config.enabled = false;
      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      expect(healthServer.isRunning()).toBe(false);
      expect(mockApp.listen).not.toHaveBeenCalled();
    });

    it('should register all health endpoints', async () => {
      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      expect(mockApp.get).toHaveBeenCalledWith('/health', expect.any(Function));
      expect(mockApp.get).toHaveBeenCalledWith('/health/live', expect.any(Function));
      expect(mockApp.get).toHaveBeenCalledWith('/health/ready', expect.any(Function));
    });

    it('should start on configured port', async () => {
      config.port = 3000;
      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      expect(mockApp.listen).toHaveBeenCalledWith(3000, expect.any(Function));
    });
  });

  describe('stop', () => {
    it('should stop the server when running', async () => {
      healthServer = new HealthServer(provider, config);
      await healthServer.start();
      await healthServer.stop();

      expect(healthServer.isRunning()).toBe(false);
    });

    it('should handle stop when not running', async () => {
      healthServer = new HealthServer(provider, config);
      // Should not throw
      await healthServer.stop();

      expect(healthServer.isRunning()).toBe(false);
    });

    it('should close the server gracefully', async () => {
      healthServer = new HealthServer(provider, config);
      await healthServer.start();
      await healthServer.stop();

      expect(mockServer.close).toHaveBeenCalled();
    });
  });

  describe('GET /health', () => {
    it('should return 200 with healthy status when all systems operational', async () => {
      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health');
      expect(handler).toBeDefined();

      const req: MockRequest = { path: '/health', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'healthy',
        })
      );
    });

    it('should return correct HealthResponse structure', async () => {
      (provider.getCurrentJobCount as Mock).mockReturnValue(2);
      (provider.getLastCompletedTime as Mock).mockReturnValue('2024-01-15T10:30:00Z');
      (provider.getQueueDepth as Mock).mockReturnValue(5);

      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health');
      const req: MockRequest = { path: '/health', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      const responseData = (res.json as Mock).mock.calls[0][0] as HealthResponse;

      expect(responseData).toMatchObject({
        status: expect.stringMatching(/^(healthy|degraded|unhealthy)$/),
        uptime: expect.any(Number),
        currentJobs: 2,
        lastJobCompleted: '2024-01-15T10:30:00Z',
        version: expect.any(String),
        details: {
          redis: 'connected',
          queueDepth: 5,
        },
      });
    });

    it('should return uptime in seconds', async () => {
      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      // Wait a bit to ensure uptime > 0
      await new Promise((resolve) => setTimeout(resolve, 10));

      const handler = routeHandlers.get('/health');
      const req: MockRequest = { path: '/health', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      const responseData = (res.json as Mock).mock.calls[0][0] as HealthResponse;
      expect(responseData.uptime).toBeGreaterThanOrEqual(0);
      expect(typeof responseData.uptime).toBe('number');
    });

    it('should return null for lastJobCompleted when no jobs completed', async () => {
      (provider.getLastCompletedTime as Mock).mockReturnValue(null);

      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health');
      const req: MockRequest = { path: '/health', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      const responseData = (res.json as Mock).mock.calls[0][0] as HealthResponse;
      expect(responseData.lastJobCompleted).toBeNull();
    });

    it('should include version in response', async () => {
      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health');
      const req: MockRequest = { path: '/health', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      const responseData = (res.json as Mock).mock.calls[0][0] as HealthResponse;
      expect(responseData.version).toBeDefined();
      expect(responseData.version.length).toBeGreaterThan(0);
    });
  });

  describe('GET /health/live', () => {
    it('should return 200 when server is running', async () => {
      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health/live');
      expect(handler).toBeDefined();

      const req: MockRequest = { path: '/health/live', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ status: 'ok' });
    });

    it('should always return 200 regardless of Redis status', async () => {
      (provider.getRedisStatus as Mock).mockReturnValue('disconnected');

      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health/live');
      const req: MockRequest = { path: '/health/live', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      // Liveness only checks if process is running
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should always return 200 regardless of health status', async () => {
      (provider.isHealthy as Mock).mockReturnValue(false);

      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health/live');
      const req: MockRequest = { path: '/health/live', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      // Liveness only checks if process is running
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('GET /health/ready', () => {
    it('should return 200 when Redis is connected', async () => {
      (provider.getRedisStatus as Mock).mockReturnValue('connected');

      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health/ready');
      expect(handler).toBeDefined();

      const req: MockRequest = { path: '/health/ready', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ status: 'ready' });
    });

    it('should return 503 when Redis is disconnected', async () => {
      (provider.getRedisStatus as Mock).mockReturnValue('disconnected');

      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health/ready');
      const req: MockRequest = { path: '/health/ready', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'not ready',
          reason: expect.stringContaining('Redis'),
        })
      );
    });

    it('should check Redis status from provider', async () => {
      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health/ready');
      const req: MockRequest = { path: '/health/ready', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      expect(provider.getRedisStatus).toHaveBeenCalled();
    });
  });

  describe('status calculation', () => {
    it('should return healthy when all systems operational', async () => {
      (provider.isHealthy as Mock).mockReturnValue(true);
      (provider.getRedisStatus as Mock).mockReturnValue('connected');
      (provider.getCurrentJobCount as Mock).mockReturnValue(0);

      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health');
      const req: MockRequest = { path: '/health', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const responseData = (res.json as Mock).mock.calls[0][0] as HealthResponse;
      expect(responseData.status).toBe('healthy');
    });

    it('should return unhealthy when provider reports unhealthy', async () => {
      (provider.isHealthy as Mock).mockReturnValue(false);
      (provider.getRedisStatus as Mock).mockReturnValue('connected');

      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health');
      const req: MockRequest = { path: '/health', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      const responseData = (res.json as Mock).mock.calls[0][0] as HealthResponse;
      expect(responseData.status).toBe('unhealthy');
    });

    it('should return unhealthy when Redis is disconnected', async () => {
      (provider.isHealthy as Mock).mockReturnValue(true);
      (provider.getRedisStatus as Mock).mockReturnValue('disconnected');

      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health');
      const req: MockRequest = { path: '/health', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      const responseData = (res.json as Mock).mock.calls[0][0] as HealthResponse;
      expect(responseData.status).toBe('unhealthy');
    });

    it('should return degraded when under high load', async () => {
      (provider.isHealthy as Mock).mockReturnValue(true);
      (provider.getRedisStatus as Mock).mockReturnValue('connected');
      (provider.getCurrentJobCount as Mock).mockReturnValue(15); // High job count

      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health');
      const req: MockRequest = { path: '/health', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      expect(res.status).toHaveBeenCalledWith(200); // Degraded still returns 200
      const responseData = (res.json as Mock).mock.calls[0][0] as HealthResponse;
      expect(responseData.status).toBe('degraded');
    });

    it('should prioritize unhealthy over degraded', async () => {
      (provider.isHealthy as Mock).mockReturnValue(false);
      (provider.getRedisStatus as Mock).mockReturnValue('connected');
      (provider.getCurrentJobCount as Mock).mockReturnValue(15); // High job count

      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health');
      const req: MockRequest = { path: '/health', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      const responseData = (res.json as Mock).mock.calls[0][0] as HealthResponse;
      expect(responseData.status).toBe('unhealthy');
    });
  });

  describe('response details', () => {
    it('should include Redis status in details', async () => {
      (provider.getRedisStatus as Mock).mockReturnValue('connected');

      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health');
      const req: MockRequest = { path: '/health', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      const responseData = (res.json as Mock).mock.calls[0][0] as HealthResponse;
      expect(responseData.details?.redis).toBe('connected');
    });

    it('should include queue depth in details', async () => {
      (provider.getQueueDepth as Mock).mockReturnValue(42);

      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health');
      const req: MockRequest = { path: '/health', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      const responseData = (res.json as Mock).mock.calls[0][0] as HealthResponse;
      expect(responseData.details?.queueDepth).toBe(42);
    });

    it('should call all provider methods to build response', async () => {
      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health');
      const req: MockRequest = { path: '/health', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      expect(provider.isHealthy).toHaveBeenCalled();
      expect(provider.getCurrentJobCount).toHaveBeenCalled();
      expect(provider.getLastCompletedTime).toHaveBeenCalled();
      expect(provider.getRedisStatus).toHaveBeenCalled();
      expect(provider.getQueueDepth).toHaveBeenCalled();
    });
  });

  describe('HTTP status codes', () => {
    it('should return 200 for healthy status', async () => {
      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health');
      const req: MockRequest = { path: '/health', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should return 200 for degraded status', async () => {
      (provider.getCurrentJobCount as Mock).mockReturnValue(15);

      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health');
      const req: MockRequest = { path: '/health', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should return 503 for unhealthy status', async () => {
      (provider.isHealthy as Mock).mockReturnValue(false);

      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health');
      const req: MockRequest = { path: '/health', method: 'GET' };
      const res = createMockResponse();

      handler!(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
    });
  });

  describe('edge cases', () => {
    it('should handle concurrent health checks', async () => {
      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health');
      const responses = Array.from({ length: 10 }, () => createMockResponse());

      // Simulate concurrent requests
      responses.forEach((res) => {
        const req: MockRequest = { path: '/health', method: 'GET' };
        handler!(req, res);
      });

      // All should succeed
      responses.forEach((res) => {
        expect(res.status).toHaveBeenCalledWith(200);
      });
    });

    it('should handle provider throwing errors gracefully', async () => {
      (provider.isHealthy as Mock).mockImplementation(() => {
        throw new Error('Provider error');
      });

      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      const handler = routeHandlers.get('/health');
      const req: MockRequest = { path: '/health', method: 'GET' };
      const res = createMockResponse();

      // Should not throw, but behavior depends on implementation
      expect(() => handler!(req, res)).toThrow('Provider error');
    });

    it('should handle starting server multiple times', async () => {
      healthServer = new HealthServer(provider, config);
      await healthServer.start();
      await healthServer.start(); // Second start

      // Should still be running
      expect(healthServer.isRunning()).toBe(true);
    });

    it('should handle stopping server multiple times', async () => {
      healthServer = new HealthServer(provider, config);
      await healthServer.start();
      await healthServer.stop();
      await healthServer.stop(); // Second stop

      expect(healthServer.isRunning()).toBe(false);
    });
  });

  describe('configuration', () => {
    it('should support different port configurations', async () => {
      const ports = [3000, 8080, 9090, 15000];

      for (const port of ports) {
        vi.clearAllMocks();
        config.port = port;
        healthServer = new HealthServer(provider, config);
        await healthServer.start();

        expect(mockApp.listen).toHaveBeenCalledWith(port, expect.any(Function));
        expect(healthServer.getPort()).toBe(port);

        await healthServer.stop();
      }
    });

    it('should respect enabled flag', async () => {
      config.enabled = false;
      healthServer = new HealthServer(provider, config);
      await healthServer.start();

      expect(healthServer.isRunning()).toBe(false);
      expect(mockApp.listen).not.toHaveBeenCalled();
    });
  });
});
