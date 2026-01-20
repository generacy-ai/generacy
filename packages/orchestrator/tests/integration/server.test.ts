import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, startServer } from '../../src/server.js';
import { createTestConfig } from '../../src/config/index.js';
import type { FastifyInstance } from 'fastify';

describe('Server Integration', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    const config = createTestConfig({
      auth: {
        enabled: false,
        providers: [],
        jwt: {
          secret: 'test-secret-at-least-32-characters-long',
          expiresIn: '1h',
        },
      },
    });

    server = await createServer({ config });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  describe('Server lifecycle', () => {
    it('should create server successfully', () => {
      expect(server).toBeDefined();
    });

    it('should have config decorated', () => {
      expect(server.config).toBeDefined();
      expect(server.config.server).toBeDefined();
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
      expect(body.services).toBeDefined();
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

  describe('Metrics endpoint', () => {
    it('GET /metrics should return Prometheus metrics', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.payload).toContain('nodejs_');
    });
  });

  describe('CORS', () => {
    it('should include CORS headers', async () => {
      const response = await server.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': 'GET',
        },
      });

      expect(response.headers['access-control-allow-origin']).toBeDefined();
    });
  });

  describe('Correlation ID', () => {
    it('should add correlation ID to response', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.headers['x-request-id']).toBeDefined();
    });

    it('should use provided correlation ID', async () => {
      const correlationId = 'test-correlation-123';

      const response = await server.inject({
        method: 'GET',
        url: '/health',
        headers: {
          'x-request-id': correlationId,
        },
      });

      expect(response.headers['x-request-id']).toBe(correlationId);
    });
  });

  describe('Error handling', () => {
    it('should return RFC 7807 format for 404', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/nonexistent-route',
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');

      const body = JSON.parse(response.payload);
      expect(body.type).toBe('urn:generacy:error:not-found');
      expect(body.title).toBe('Not Found');
      expect(body.status).toBe(404);
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
      expect(body.pagination).toBeDefined();
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

    it('GET /integrations should return integration status', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/integrations',
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.integrations).toBeDefined();
      expect(Array.isArray(body.integrations)).toBe(true);
    });
  });

  describe('Workflow CRUD', () => {
    it('should create and retrieve a workflow', async () => {
      // Create workflow
      const createResponse = await server.inject({
        method: 'POST',
        url: '/workflows',
        payload: {
          definition: { steps: [] },
          context: { test: true },
          metadata: { name: 'Test Workflow' },
        },
      });

      expect(createResponse.statusCode).toBe(201);

      const created = JSON.parse(createResponse.payload);
      expect(created.id).toBeDefined();
      expect(created.status).toBe('created');

      // Retrieve workflow
      const getResponse = await server.inject({
        method: 'GET',
        url: `/workflows/${created.id}`,
      });

      expect(getResponse.statusCode).toBe(200);

      const retrieved = JSON.parse(getResponse.payload);
      expect(retrieved.id).toBe(created.id);
    });
  });
});

describe('Server with authentication', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    const config = createTestConfig({
      auth: {
        enabled: true,
        providers: ['apiKey'],
        jwt: {
          secret: 'test-secret-at-least-32-characters-long',
          expiresIn: '1h',
        },
      },
    });

    server = await createServer({ config });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('should require authentication for protected routes', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/workflows',
    });

    expect(response.statusCode).toBe(401);

    const body = JSON.parse(response.payload);
    expect(body.type).toBe('urn:generacy:error:unauthorized');
  });

  it('should allow unauthenticated access to health endpoints', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
  });

  it('should allow unauthenticated access to metrics', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(response.statusCode).toBe(200);
  });
});
