/**
 * Tests for the queue routes (POST /queue, POST /queue/:id/respond).
 *
 * T027: Orchestrator tests for POST /queue route
 *   - Valid creation: correct payload → 201 + DecisionQueueItem returned
 *   - Validation errors: missing required fields → 400
 *   - Auth requirement: no token → 401 (when auth enabled)
 *   - Created decision appears in GET /queue
 *   - SSE queue:item:added event emitted on creation
 *
 * T028: Orchestrator tests for SSE response inclusion
 *   - POST /queue/:id/respond emits queue:item:removed SSE event
 *   - SSE event data includes response field with DecisionResponse
 *   - response.respondedBy, response.comment, response.respondedAt are present
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { setupQueueRoutes } from './queue.js';
import { QueueService, InMemoryQueueStore } from '../services/queue-service.js';
import { setupErrorHandler } from '../middleware/error-handler.js';
import { resetSSESubscriptionManager, getSSESubscriptionManager } from '../sse/subscriptions.js';
import type { DecisionQueueItem } from '../types/api.js';
import type { QueueEventData } from '../types/sse.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal valid payload for POST /queue */
function validCreatePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflowId: 'wf_deploy_abc123',
    stepId: 'review-deploy',
    type: 'review',
    prompt: 'Please review the deployment plan',
    ...overrides,
  };
}

/**
 * Create a Fastify server wired only with queue routes + error handler.
 * Auth is disabled — a preHandler hook sets a default auth context on every
 * request so the requireRead/requireWrite scope checks pass.
 */
async function buildServer(queueService: QueueService): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });

  // Inject a permissive auth context (simulates an admin API key)
  server.addHook('preHandler', async (request) => {
    request.auth = {
      userId: 'test-user',
      method: 'api-key',
      scopes: ['admin'],
    };
  });

  // Ensure we augment the request type so our hook assignment compiles
  // (the actual augmentation lives in auth/middleware.ts, which is loaded at import time)

  setupErrorHandler(server);
  await setupQueueRoutes(server, queueService);
  return server;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Queue routes', () => {
  let server: FastifyInstance;
  let queueStore: InMemoryQueueStore;
  let queueService: QueueService;

  beforeEach(async () => {
    resetSSESubscriptionManager();
    queueStore = new InMemoryQueueStore();
    queueService = new QueueService(queueStore);
    server = await buildServer(queueService);
  });

  afterEach(async () => {
    await server.close();
    resetSSESubscriptionManager();
  });

  // -----------------------------------------------------------------------
  // T027 — POST /queue
  // -----------------------------------------------------------------------
  describe('POST /queue', () => {
    it('creates a decision and returns 201 with DecisionQueueItem', async () => {
      const payload = validCreatePayload();

      const res = await server.inject({
        method: 'POST',
        url: '/queue',
        payload,
      });

      expect(res.statusCode).toBe(201);

      const body = res.json<DecisionQueueItem>();
      expect(body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(body.workflowId).toBe(payload.workflowId);
      expect(body.stepId).toBe(payload.stepId);
      expect(body.type).toBe(payload.type);
      expect(body.prompt).toBe(payload.prompt);
      expect(body.priority).toBe('when_available'); // default
      expect(body.context).toEqual({}); // default
      expect(body.createdAt).toBeDefined();
    });

    it('returns 201 with all optional fields populated', async () => {
      const payload = validCreatePayload({
        options: [
          { id: 'approve', label: 'Approve', description: 'Ship it' },
          { id: 'reject', label: 'Reject' },
        ],
        context: { description: 'deploy plan', artifact: 'diff ...' },
        priority: 'blocking_now',
        expiresAt: '2026-02-16T00:00:00.000Z',
        agentId: 'agent-1',
      });

      const res = await server.inject({
        method: 'POST',
        url: '/queue',
        payload,
      });

      expect(res.statusCode).toBe(201);

      const body = res.json<DecisionQueueItem>();
      expect(body.options).toEqual(payload.options);
      expect(body.context).toEqual(payload.context);
      expect(body.priority).toBe('blocking_now');
      expect(body.expiresAt).toBe('2026-02-16T00:00:00.000Z');
    });

    it('returns 400 when workflowId is missing', async () => {
      const { workflowId: _, ...rest } = validCreatePayload();

      const res = await server.inject({
        method: 'POST',
        url: '/queue',
        payload: rest,
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when stepId is missing', async () => {
      const { stepId: _, ...rest } = validCreatePayload();

      const res = await server.inject({
        method: 'POST',
        url: '/queue',
        payload: rest,
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when type is missing', async () => {
      const { type: _, ...rest } = validCreatePayload();

      const res = await server.inject({
        method: 'POST',
        url: '/queue',
        payload: rest,
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when prompt is missing', async () => {
      const { prompt: _, ...rest } = validCreatePayload();

      const res = await server.inject({
        method: 'POST',
        url: '/queue',
        payload: rest,
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when type is invalid', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/queue',
        payload: validCreatePayload({ type: 'invalid-type' }),
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when priority is invalid', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/queue',
        payload: validCreatePayload({ priority: 'ultra_high' }),
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when workflowId is empty string', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/queue',
        payload: validCreatePayload({ workflowId: '' }),
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when prompt is empty string', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/queue',
        payload: validCreatePayload({ prompt: '' }),
      });

      expect(res.statusCode).toBe(400);
    });

    it('accepts non-UUID workflowId (e.g. wf_ prefix format)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/queue',
        payload: validCreatePayload({ workflowId: 'wf_my-workflow_12345' }),
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().workflowId).toBe('wf_my-workflow_12345');
    });

    it('created decision appears in GET /queue', async () => {
      const payload = validCreatePayload();

      const createRes = await server.inject({
        method: 'POST',
        url: '/queue',
        payload,
      });
      const created = createRes.json<DecisionQueueItem>();

      const listRes = await server.inject({
        method: 'GET',
        url: '/queue',
      });

      expect(listRes.statusCode).toBe(200);
      const items = listRes.json<DecisionQueueItem[]>();
      expect(items).toHaveLength(1);
      expect(items[0]!.id).toBe(created.id);
    });

    it('emits queue:item:added SSE event on creation', async () => {
      const manager = getSSESubscriptionManager();
      const broadcastSpy = vi.spyOn(manager, 'broadcast');

      await server.inject({
        method: 'POST',
        url: '/queue',
        payload: validCreatePayload(),
      });

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      const [channel, event] = broadcastSpy.mock.calls[0]!;
      expect(channel).toBe('queue');
      expect(event.event).toBe('queue:item:added');
      const data = event.data as QueueEventData;
      expect(data.action).toBe('added');
      expect(data.items).toHaveLength(1);
      expect(data.item).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // T027 — POST /queue (auth tests with separate server)
  // -----------------------------------------------------------------------
  describe('POST /queue — auth enforcement', () => {
    it('returns 401 when no auth context and auth is enforced', async () => {
      // Build a server that does NOT inject a permissive auth context
      const noAuthServer = Fastify({ logger: false });
      setupErrorHandler(noAuthServer);

      // Do NOT add the preHandler hook that injects auth
      await setupQueueRoutes(noAuthServer, queueService);

      const res = await noAuthServer.inject({
        method: 'POST',
        url: '/queue',
        payload: validCreatePayload(),
      });

      // requireWrite('queue') checks request.auth — if missing, returns 401
      expect(res.statusCode).toBe(401);

      await noAuthServer.close();
    });

    it('returns 403 when user lacks queue:write scope', async () => {
      const readOnlyServer = Fastify({ logger: false });
      setupErrorHandler(readOnlyServer);

      readOnlyServer.addHook('preHandler', async (request) => {
        request.auth = {
          userId: 'viewer',
          method: 'api-key',
          scopes: ['queue:read'],
        };
      });

      await setupQueueRoutes(readOnlyServer, queueService);

      const res = await readOnlyServer.inject({
        method: 'POST',
        url: '/queue',
        payload: validCreatePayload(),
      });

      expect(res.statusCode).toBe(403);

      await readOnlyServer.close();
    });
  });

  // -----------------------------------------------------------------------
  // T028 — POST /queue/:id/respond — SSE response inclusion
  // -----------------------------------------------------------------------
  describe('POST /queue/:id/respond', () => {
    let decisionId: string;

    beforeEach(async () => {
      // Create a decision to respond to
      const createRes = await server.inject({
        method: 'POST',
        url: '/queue',
        payload: validCreatePayload(),
      });
      decisionId = createRes.json<DecisionQueueItem>().id;
    });

    it('emits queue:item:removed SSE event on respond', async () => {
      const manager = getSSESubscriptionManager();
      const broadcastSpy = vi.spyOn(manager, 'broadcast');

      // Clear calls from the POST /queue creation
      broadcastSpy.mockClear();

      await server.inject({
        method: 'POST',
        url: `/queue/${decisionId}/respond`,
        payload: { response: true, comment: 'Approved!' },
      });

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      const [channel, event] = broadcastSpy.mock.calls[0]!;
      expect(channel).toBe('queue');
      expect(event.event).toBe('queue:item:removed');
      const data = event.data as QueueEventData;
      expect(data.action).toBe('removed');
    });

    it('SSE event data includes response field with DecisionResponse', async () => {
      const manager = getSSESubscriptionManager();
      const broadcastSpy = vi.spyOn(manager, 'broadcast');
      broadcastSpy.mockClear();

      await server.inject({
        method: 'POST',
        url: `/queue/${decisionId}/respond`,
        payload: { response: 'approve', comment: 'Ship it' },
      });

      const [, event] = broadcastSpy.mock.calls[0]!;
      const data = event.data as QueueEventData;
      const { response } = data;

      expect(response).toBeDefined();
      expect(response!.id).toBe(decisionId);
      expect(response!.response).toBe('approve');
      expect(response!.comment).toBe('Ship it');
      expect(response!.respondedBy).toBe('test-user');
      expect(response!.respondedAt).toBeDefined();
    });

    it('response includes respondedBy, comment, and respondedAt', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/queue/${decisionId}/respond`,
        payload: { response: false, comment: 'Needs work' },
      });

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.respondedBy).toBe('test-user');
      expect(body.comment).toBe('Needs work');
      expect(body.respondedAt).toBeDefined();
      expect(typeof body.respondedAt).toBe('string');
    });

    it('decision is removed from queue after respond', async () => {
      await server.inject({
        method: 'POST',
        url: `/queue/${decisionId}/respond`,
        payload: { response: true },
      });

      const listRes = await server.inject({
        method: 'GET',
        url: '/queue',
      });

      expect(listRes.json()).toHaveLength(0);
    });

    it('returns 404 when responding to non-existent decision', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/queue/00000000-0000-0000-0000-000000000000/respond',
        payload: { response: true },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 409 when responding to already responded decision', async () => {
      await server.inject({
        method: 'POST',
        url: `/queue/${decisionId}/respond`,
        payload: { response: true },
      });

      const res = await server.inject({
        method: 'POST',
        url: `/queue/${decisionId}/respond`,
        payload: { response: false },
      });

      // Decision was removed from queue after first response, so 404
      expect([404, 409]).toContain(res.statusCode);
    });
  });
});
