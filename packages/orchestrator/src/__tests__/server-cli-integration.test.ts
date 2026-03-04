/**
 * Integration test: Fastify server starts via CLI config (no Redis)
 *
 * T020: Verifies the Fastify server can start with a CLI-style config
 * when Redis is unavailable, falling back to InMemoryQueueAdapter.
 *
 * Test Coverage:
 * - Server creates successfully with no Redis connection
 * - Config is decorated on the Fastify instance
 * - Health endpoint returns 200
 * - Dispatch queue routes use InMemoryQueueAdapter (depth=0, workers=0)
 * - API routes (workflows, queue, agents) respond correctly
 * - Graceful shutdown completes without errors
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server.js';
import { createTestConfig } from '../config/index.js';
import type { FastifyInstance } from 'fastify';

describe('T020: Fastify server starts via CLI config (no Redis)', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    // Build config mimicking CLI flags with an unreachable Redis URL
    // so the server falls back to InMemoryQueueAdapter
    const config = createTestConfig({
      server: {
        port: 0,
        host: '127.0.0.1',
      },
      redis: {
        url: 'redis://127.0.0.1:1', // Unreachable port — triggers in-memory fallback
      },
      auth: {
        enabled: false,
        providers: [],
        jwt: {
          secret: 'test-secret-at-least-32-characters-long',
          expiresIn: '1h',
        },
      },
      logging: {
        level: 'error',
        pretty: false,
      },
    });

    server = await createServer({ config });
    await server.ready();
  }, 15_000); // Redis connection timeout can take a few seconds

  afterAll(async () => {
    await server.close();
  });

  describe('Server lifecycle', () => {
    it('should create server successfully without Redis', () => {
      expect(server).toBeDefined();
    });

    it('should have config decorated on server', () => {
      expect(server.config).toBeDefined();
      expect(server.config.server.host).toBe('127.0.0.1');
      expect(server.config.redis.url).toBe('redis://127.0.0.1:1');
    });
  });

  describe('Health endpoints', () => {
    it('GET /health should return 200', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
    });

    it('GET /health/live should return 200', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health/live',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe('ok');
    });

    it('GET /health/ready should return 200', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('Dispatch queue routes (InMemoryQueueAdapter)', () => {
    it('GET /dispatch/queue/depth should return 0', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dispatch/queue/depth',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.depth).toBe(0);
    });

    it('GET /dispatch/queue/items should return empty list', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dispatch/queue/items',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.items).toEqual([]);
    });

    it('GET /dispatch/queue/workers should return 0 active workers', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dispatch/queue/workers',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.count).toBe(0);
    });
  });

  describe('API routes', () => {
    it('GET /workflows should return workflow list', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/workflows',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.workflows).toBeDefined();
      expect(Array.isArray(body.workflows)).toBe(true);
    });

    it('GET /queue should return decision queue', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/queue',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(Array.isArray(body)).toBe(true);
    });

    it('GET /agents should return agent list', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/agents',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(Array.isArray(body)).toBe(true);
    });
  });

  describe('Graceful shutdown', () => {
    it('should shut down within a reasonable time', async () => {
      // Create a separate server instance for the shutdown test
      // so it doesn't affect other tests
      const config = createTestConfig({
        redis: {
          url: 'redis://127.0.0.1:1',
        },
        auth: {
          enabled: false,
          providers: [],
          jwt: {
            secret: 'test-secret-at-least-32-characters-long',
            expiresIn: '1h',
          },
        },
        logging: {
          level: 'error',
          pretty: false,
        },
      });

      const shutdownServer = await createServer({ config });
      await shutdownServer.ready();

      const start = Date.now();
      await shutdownServer.close();
      const elapsed = Date.now() - start;

      // Shutdown should complete quickly (no Redis to disconnect, no active workers)
      expect(elapsed).toBeLessThan(5000);
    }, 15_000);
  });
});
