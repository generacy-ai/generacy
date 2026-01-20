import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer } from '../../../src/server.js';
import { setupHealthRoutes } from '../../../src/routes/health.js';
import type { FastifyInstance } from 'fastify';

describe('Health Routes', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createTestServer();
    await setupHealthRoutes(server, {
      checks: {
        database: async () => 'ok',
        redis: async () => 'ok',
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  describe('GET /health', () => {
    it('should return 200 when all services are healthy', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
      expect(body.services).toBeDefined();
      expect(body.services.server).toBe('ok');
      expect(body.services.database).toBe('ok');
      expect(body.services.redis).toBe('ok');
    });
  });

  describe('GET /health/live', () => {
    it('should return 200 for liveness check', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health/live',
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.status).toBe('ok');
    });
  });

  describe('GET /health/ready', () => {
    it('should return 200 when ready', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.status).toBe('ok');
    });
  });
});

describe('Health Routes with failing services', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createTestServer();
    await setupHealthRoutes(server, {
      checks: {
        database: async () => 'ok',
        redis: async () => 'error',
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  describe('GET /health', () => {
    it('should return 200 with degraded status when some services fail', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.status).toBe('degraded');
      expect(body.services.database).toBe('ok');
      expect(body.services.redis).toBe('error');
    });
  });

  describe('GET /health/ready', () => {
    it('should return 503 when services fail', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(503);

      const body = JSON.parse(response.payload);
      expect(body.status).toBe('not ready');
    });
  });
});
