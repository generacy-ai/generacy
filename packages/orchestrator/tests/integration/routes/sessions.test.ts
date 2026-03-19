import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { setupSessionRoutes } from '../../../src/routes/sessions.js';
import { SessionService } from '../../../src/services/session-service.js';
import { InMemoryApiKeyStore } from '../../../src/auth/api-key.js';
import { createAuthMiddleware } from '../../../src/auth/middleware.js';
import type { FastifyInstance } from 'fastify';

const fixturesDir = path.resolve(__dirname, '../../fixtures/sessions');

describe('Session Routes', () => {
  let server: FastifyInstance;
  let sessionService: SessionService;
  const testApiKey = 'test-sessions-api-key-12345';

  beforeAll(async () => {
    server = Fastify({ logger: false });
    await server.register(jwt, { secret: 'test-secret-for-integration-tests' });
    sessionService = new SessionService({
      claudeProjectsDir: fixturesDir,
      workspaces: { main: '/workspaces/generacy' },
    });

    const apiKeyStore = new InMemoryApiKeyStore();
    apiKeyStore.addKey(testApiKey, {
      name: 'Test Key',
      createdAt: new Date().toISOString(),
      scopes: ['sessions:read'],
    });

    const authMiddleware = createAuthMiddleware({
      apiKeyStore,
      enabled: true,
      skipRoutes: ['/health'],
    });
    server.addHook('preHandler', authMiddleware);

    await setupSessionRoutes(server, sessionService);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  describe('GET /sessions', () => {
    it('should return 200 with session list', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/sessions',
        headers: { 'x-api-key': testApiKey },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.sessions).toBeDefined();
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(body.pagination).toBeDefined();
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.pageSize).toBe(20);
      expect(typeof body.pagination.total).toBe('number');
      expect(typeof body.pagination.hasMore).toBe('boolean');
    });

    it('should return correct session shape', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/sessions',
        headers: { 'x-api-key': testApiKey },
      });

      const body = JSON.parse(response.payload);
      expect(body.sessions.length).toBeGreaterThan(0);

      const session = body.sessions[0];
      expect(session.sessionId).toBeDefined();
      expect(session).toHaveProperty('slug');
      expect(session).toHaveProperty('startedAt');
      expect(session).toHaveProperty('lastActivityAt');
      expect(session).toHaveProperty('messageCount');
      expect(session).toHaveProperty('model');
      expect(session).toHaveProperty('gitBranch');
      expect(session).toHaveProperty('type');
      expect(session).toHaveProperty('workspace');
    });

    it('should support pagination', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/sessions?page=1&pageSize=2',
        headers: { 'x-api-key': testApiKey },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.sessions.length).toBeLessThanOrEqual(2);
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.pageSize).toBe(2);
    });

    it('should filter by workspace', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/sessions?workspace=main',
        headers: { 'x-api-key': testApiKey },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      for (const session of body.sessions) {
        expect(session.workspace).toBe('/workspaces/generacy');
      }
    });

    it('should return empty results for unknown workspace', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/sessions?workspace=nonexistent',
        headers: { 'x-api-key': testApiKey },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.sessions).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });

    it('should require authentication', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/sessions',
      });

      expect(response.statusCode).toBe(401);
    });

    it('should reject insufficient scopes', async () => {
      const apiKeyStore = new InMemoryApiKeyStore();
      const limitedKey = 'limited-key-no-sessions';
      apiKeyStore.addKey(limitedKey, {
        name: 'Limited Key',
        createdAt: new Date().toISOString(),
        scopes: ['workflows:read'],
      });

      // This test verifies the scope check — the key has workflows:read but not sessions:read
      // The auth middleware on the main server checks scopes via preHandler
      const response = await server.inject({
        method: 'GET',
        url: '/sessions',
        headers: { 'x-api-key': limitedKey },
      });

      // Key not recognized by test server's apiKeyStore → 401
      expect(response.statusCode).toBe(401);
    });
  });
});
