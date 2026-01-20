import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestServer } from '../../../src/server.js';
import { setupQueueRoutes } from '../../../src/routes/queue.js';
import { QueueService, InMemoryQueueStore } from '../../../src/services/queue-service.js';
import { InMemoryApiKeyStore } from '../../../src/auth/api-key.js';
import { createAuthMiddleware } from '../../../src/auth/middleware.js';
import type { FastifyInstance } from 'fastify';
import type { DecisionQueueItem } from '../../../src/types/index.js';

describe('Queue Routes', () => {
  let server: FastifyInstance;
  let queueStore: InMemoryQueueStore;
  let queueService: QueueService;
  let apiKeyStore: InMemoryApiKeyStore;
  const testApiKey = 'test-api-key-12345678';

  const createDecision = (
    overrides: Partial<DecisionQueueItem> = {}
  ): DecisionQueueItem => ({
    id: crypto.randomUUID(),
    workflowId: crypto.randomUUID(),
    stepId: 'step-1',
    type: 'approval',
    prompt: 'Approve this change?',
    context: {},
    priority: 'when_available',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  beforeAll(async () => {
    server = await createTestServer();
    queueStore = new InMemoryQueueStore();
    queueService = new QueueService(queueStore);
    apiKeyStore = new InMemoryApiKeyStore();

    // Add test API key
    apiKeyStore.addKey(testApiKey, {
      name: 'Test Key',
      createdAt: new Date().toISOString(),
      scopes: ['queue:read', 'queue:write'],
    });

    // Add auth middleware
    const authMiddleware = createAuthMiddleware({
      apiKeyStore,
      enabled: true,
      skipRoutes: ['/health'],
    });
    server.addHook('preHandler', authMiddleware);

    await setupQueueRoutes(server, queueService);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    queueStore.clear();
  });

  describe('GET /queue', () => {
    it('should return empty queue', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/queue',
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body).toHaveLength(0);
    });

    it('should return queue items', async () => {
      queueStore.addDecision(createDecision({ id: '1' }));
      queueStore.addDecision(createDecision({ id: '2' }));

      const response = await server.inject({
        method: 'GET',
        url: '/queue',
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body).toHaveLength(2);
    });

    it('should filter by priority', async () => {
      queueStore.addDecision(createDecision({ id: '1', priority: 'blocking_now' }));
      queueStore.addDecision(createDecision({ id: '2', priority: 'when_available' }));

      const response = await server.inject({
        method: 'GET',
        url: '/queue?priority=blocking_now',
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body).toHaveLength(1);
      expect(body[0].priority).toBe('blocking_now');
    });

    it('should require authentication', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/queue',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /queue/:id', () => {
    it('should get decision by ID', async () => {
      const testId = crypto.randomUUID();
      const decision = createDecision({ id: testId });
      queueStore.addDecision(decision);

      const response = await server.inject({
        method: 'GET',
        url: `/queue/${testId}`,
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.id).toBe(testId);
    });

    it('should return 404 for non-existent decision', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/queue/00000000-0000-0000-0000-000000000000',
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /queue/:id/respond', () => {
    it('should respond to a decision', async () => {
      const testId = crypto.randomUUID();
      const decision = createDecision({ id: testId });
      queueStore.addDecision(decision);

      const response = await server.inject({
        method: 'POST',
        url: `/queue/${testId}/respond`,
        headers: {
          'x-api-key': testApiKey,
        },
        payload: {
          response: true,
          comment: 'Approved',
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.id).toBe(testId);
      expect(body.response).toBe(true);
      expect(body.comment).toBe('Approved');
      expect(body.respondedBy).toContain('apikey');
    });

    it('should validate response body', async () => {
      const testId = crypto.randomUUID();
      const decision = createDecision({ id: testId });
      queueStore.addDecision(decision);

      const response = await server.inject({
        method: 'POST',
        url: `/queue/${testId}/respond`,
        headers: {
          'x-api-key': testApiKey,
        },
        payload: {
          // Missing required response field
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /queue/stats', () => {
    it('should return queue statistics', async () => {
      queueStore.addDecision(createDecision({ priority: 'blocking_now' }));
      queueStore.addDecision(createDecision({ priority: 'blocking_now' }));
      queueStore.addDecision(createDecision({ priority: 'when_available' }));

      const response = await server.inject({
        method: 'GET',
        url: '/queue/stats',
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.blocking_now).toBe(2);
      expect(body.blocking_soon).toBe(0);
      expect(body.when_available).toBe(1);
    });
  });
});
