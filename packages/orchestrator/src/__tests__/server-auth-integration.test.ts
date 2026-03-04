/**
 * Integration test: auth-token flag registers API key
 *
 * T021: Verifies that an API key registered via InMemoryApiKeyStore
 * (simulating the --auth-token CLI flag) authenticates requests through
 * both X-API-Key and Authorization: Bearer headers on the live Fastify server.
 *
 * Test Coverage:
 * - Pre-registered API key authenticates via X-API-Key header
 * - Pre-registered API key authenticates via Authorization: Bearer header
 * - Auth context contains correct userId, method, scopes, and apiKeyName
 * - Invalid tokens are rejected with 401
 * - Unauthenticated requests are rejected with 401
 * - Health endpoints bypass auth (skipRoutes)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server.js';
import { createTestConfig } from '../config/index.js';
import { InMemoryApiKeyStore } from '../auth/index.js';
import type { FastifyInstance } from 'fastify';

describe('T021: auth-token flag registers API key', () => {
  let server: FastifyInstance;
  const AUTH_TOKEN = 'cli-auth-token-for-testing-abc123';
  const KEY_NAME = 'cli-token';

  beforeAll(async () => {
    // Simulate the CLI --auth-token flag: pre-register a token in the API key store
    const apiKeyStore = new InMemoryApiKeyStore();
    apiKeyStore.addKey(AUTH_TOKEN, {
      name: KEY_NAME,
      createdAt: new Date().toISOString(),
      scopes: ['admin'],
    });

    const config = createTestConfig({
      server: {
        port: 0,
        host: '127.0.0.1',
      },
      redis: {
        url: 'redis://127.0.0.1:1', // Unreachable — triggers in-memory fallback
      },
      auth: {
        enabled: true,
        providers: ['apiKey'],
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

    server = await createServer({ config, apiKeyStore });

    // Register a test route that exposes the auth context (must be before ready)
    server.get('/test/auth-context', async (request) => {
      return {
        userId: request.auth.userId,
        method: request.auth.method,
        scopes: request.auth.scopes,
        apiKeyName: request.auth.apiKeyName,
      };
    });

    await server.ready();
  }, 15_000);

  afterAll(async () => {
    await server.close();
  });

  describe('X-API-Key header authentication', () => {
    it('should authenticate with valid X-API-Key', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/workflows',
        headers: {
          'x-api-key': AUTH_TOKEN,
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should reject invalid X-API-Key with 401', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/workflows',
        headers: {
          'x-api-key': 'wrong-token',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.title).toBe('Invalid API Key');
    });
  });

  describe('Authorization: Bearer header authentication', () => {
    it('should authenticate with valid Bearer token', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/workflows',
        headers: {
          authorization: `Bearer ${AUTH_TOKEN}`,
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should reject invalid Bearer token with 401', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/workflows',
        headers: {
          authorization: 'Bearer invalid-token-xyz',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.title).toBe('Invalid Token');
    });
  });

  describe('Unauthenticated requests', () => {
    it('should reject requests with no auth headers', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/workflows',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.title).toBe('Authentication Required');
    });
  });

  describe('Auth context correctness', () => {
    it('should set correct auth context for X-API-Key', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/test/auth-context',
        headers: {
          'x-api-key': AUTH_TOKEN,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.userId).toBe(`apikey:${KEY_NAME}`);
      expect(body.method).toBe('api-key');
      expect(body.scopes).toEqual(['admin']);
      expect(body.apiKeyName).toBe(KEY_NAME);
    });

    it('should set correct auth context for Bearer token', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/test/auth-context',
        headers: {
          authorization: `Bearer ${AUTH_TOKEN}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.userId).toBe(`apikey:${KEY_NAME}`);
      expect(body.method).toBe('api-key');
      expect(body.scopes).toEqual(['admin']);
      expect(body.apiKeyName).toBe(KEY_NAME);
    });
  });

  describe('Health endpoints bypass auth', () => {
    it('GET /health should return 200 without auth', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('Protected routes require auth', () => {
    it('GET /queue should require auth', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/queue',
      });

      expect(response.statusCode).toBe(401);
    });

    it('GET /agents should require auth', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/agents',
      });

      expect(response.statusCode).toBe(401);
    });

    it('GET /dispatch/queue/depth should require auth', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/dispatch/queue/depth',
      });

      expect(response.statusCode).toBe(401);
    });

    it('GET /queue should succeed with valid token', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/queue',
        headers: {
          'x-api-key': AUTH_TOKEN,
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it('GET /agents should succeed with valid token', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/agents',
        headers: {
          authorization: `Bearer ${AUTH_TOKEN}`,
        },
      });

      expect(response.statusCode).toBe(200);
    });
  });
});
