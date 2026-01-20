import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestServer } from '../../../src/server.js';
import { setupWorkflowRoutes } from '../../../src/routes/workflows.js';
import { WorkflowService, InMemoryWorkflowStore } from '../../../src/services/workflow-service.js';
import { InMemoryApiKeyStore } from '../../../src/auth/api-key.js';
import { createAuthMiddleware } from '../../../src/auth/middleware.js';
import type { FastifyInstance } from 'fastify';

describe('Workflow Routes', () => {
  let server: FastifyInstance;
  let workflowStore: InMemoryWorkflowStore;
  let workflowService: WorkflowService;
  let apiKeyStore: InMemoryApiKeyStore;
  const testApiKey = 'test-api-key-12345678';

  beforeAll(async () => {
    server = await createTestServer();
    workflowStore = new InMemoryWorkflowStore();
    workflowService = new WorkflowService(workflowStore);
    apiKeyStore = new InMemoryApiKeyStore();

    // Add test API key
    apiKeyStore.addKey(testApiKey, {
      name: 'Test Key',
      createdAt: new Date().toISOString(),
      scopes: ['workflows:read', 'workflows:write'],
    });

    // Add auth middleware
    const authMiddleware = createAuthMiddleware({
      apiKeyStore,
      enabled: true,
      skipRoutes: ['/health'],
    });
    server.addHook('preHandler', authMiddleware);

    await setupWorkflowRoutes(server, workflowService);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    workflowStore.clear();
  });

  describe('POST /workflows', () => {
    it('should create a new workflow', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/workflows',
        headers: {
          'x-api-key': testApiKey,
        },
        payload: {
          definition: { steps: [] },
          context: { projectId: '123' },
          metadata: {
            name: 'Test Workflow',
            tags: ['test'],
          },
        },
      });

      expect(response.statusCode).toBe(201);

      const body = JSON.parse(response.payload);
      expect(body.id).toBeDefined();
      expect(body.status).toBe('created');
      expect(body.context).toEqual({ projectId: '123' });
      expect(body.metadata.name).toBe('Test Workflow');

      // Check Location header
      expect(response.headers.location).toBe(`/workflows/${body.id}`);
    });

    it('should require authentication', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/workflows',
        payload: {
          context: {},
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should validate request body', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/workflows',
        headers: {
          'x-api-key': testApiKey,
        },
        payload: {
          // Missing required context
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /workflows', () => {
    it('should list workflows', async () => {
      // Create some workflows
      await workflowService.create({ context: { id: 1 } });
      await workflowService.create({ context: { id: 2 } });

      const response = await server.inject({
        method: 'GET',
        url: '/workflows',
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.workflows).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
    });

    it('should paginate results', async () => {
      for (let i = 0; i < 25; i++) {
        await workflowService.create({ context: { id: i } });
      }

      const response = await server.inject({
        method: 'GET',
        url: '/workflows?page=2&pageSize=10',
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.workflows).toHaveLength(10);
      expect(body.pagination.page).toBe(2);
    });
  });

  describe('GET /workflows/:id', () => {
    it('should get workflow by ID', async () => {
      const created = await workflowService.create({ context: { test: true } });

      const response = await server.inject({
        method: 'GET',
        url: `/workflows/${created.id}`,
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.id).toBe(created.id);
    });

    it('should return 404 for non-existent workflow', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/workflows/00000000-0000-0000-0000-000000000000',
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /workflows/:id/pause', () => {
    it('should pause a running workflow', async () => {
      const created = await workflowService.create({ context: {} });

      // Wait for workflow to start running
      await new Promise((resolve) => setTimeout(resolve, 150));

      const response = await server.inject({
        method: 'POST',
        url: `/workflows/${created.id}/pause`,
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.status).toBe('paused');
    });
  });

  describe('POST /workflows/:id/resume', () => {
    it('should resume a paused workflow', async () => {
      const created = await workflowService.create({ context: {} });

      // Wait for workflow to start running, then pause
      await new Promise((resolve) => setTimeout(resolve, 150));
      await workflowService.pause(created.id);

      const response = await server.inject({
        method: 'POST',
        url: `/workflows/${created.id}/resume`,
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.status).toBe('running');
    });
  });

  describe('DELETE /workflows/:id', () => {
    it('should cancel a workflow', async () => {
      const created = await workflowService.create({ context: {} });

      const response = await server.inject({
        method: 'DELETE',
        url: `/workflows/${created.id}`,
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect(response.statusCode).toBe(204);

      // Verify cancelled
      const workflow = await workflowService.get(created.id);
      expect(workflow.status).toBe('cancelled');
    });
  });
});
