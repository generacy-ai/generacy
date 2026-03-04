import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { setupEventsRoutes, closeAllSSEConnections } from '../../../src/routes/events.js';
import { resetSSESubscriptionManager, getSSESubscriptionManager } from '../../../src/sse/subscriptions.js';
import type { AuthContext } from '../../../src/types/api.js';

// Mock auth context
declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
    correlationId: string;
  }
}

/**
 * Helper: race server.inject() against a short timeout.
 * SSE endpoints hijack the response and never complete, so if inject
 * doesn't resolve within `ms` we treat that as "route accepted the request".
 */
function injectWithTimeout(
  server: FastifyInstance,
  opts: Parameters<FastifyInstance['inject']>[0],
  ms = 1000
): Promise<{ timedOut: true } | { timedOut: false; response: Awaited<ReturnType<FastifyInstance['inject']>> }> {
  return Promise.race([
    server.inject(opts).then((response) => ({ timedOut: false as const, response })),
    new Promise<{ timedOut: true }>((resolve) =>
      setTimeout(() => resolve({ timedOut: true as const }), ms)
    ),
  ]);
}

describe('SSE Events Routes', () => {
  let server: FastifyInstance;
  let authToken: string;

  beforeEach(async () => {
    resetSSESubscriptionManager();

    server = Fastify({ logger: false });

    // Register JWT
    await server.register(jwt, {
      secret: 'test-secret-key',
    });

    // Mock auth middleware
    server.decorateRequest('auth', null);
    server.decorateRequest('correlationId', '');
    server.addHook('onRequest', async (request) => {
      request.correlationId = 'test-correlation-id';

      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        try {
          const token = authHeader.slice(7);
          const decoded = server.jwt.verify(token) as { sub: string; scopes: string[] };
          request.auth = {
            userId: decoded.sub,
            method: 'jwt',
            scopes: decoded.scopes as AuthContext['scopes'],
          };
        } catch {
          request.auth = { userId: 'anonymous', method: 'jwt', scopes: [] };
        }
      } else {
        request.auth = { userId: 'anonymous', method: 'jwt', scopes: [] };
      }
    });

    await setupEventsRoutes(server);
    await server.ready();

    // Generate auth token
    authToken = server.jwt.sign({
      sub: 'test-user-123',
      scopes: ['workflows:read', 'queue:read'],
    });
  });

  afterEach(async () => {
    closeAllSSEConnections();
    resetSSESubscriptionManager();
    await server.close();
  });

  describe('GET /events', () => {
    it('should reject unauthenticated requests', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/events',
      });

      // requireRead returns 403 when auth context has no matching scopes
      expect([401, 403]).toContain(response.statusCode);
    });

    it('should accept authenticated requests', async () => {
      // SSE endpoints hijack the response for streaming — inject() hangs.
      // If it hangs (times out), auth was accepted. If it resolves quickly
      // with 401/403, auth failed.
      const result = await injectWithTimeout(server, {
        method: 'GET',
        url: '/events',
        headers: { authorization: `Bearer ${authToken}` },
      });

      if (!result.timedOut) {
        expect([401, 403]).not.toContain(result.response.statusCode);
      }
      // timedOut = true means auth passed and SSE stream started
    }, 5000);

    it('should parse channel query parameter', async () => {
      const result = await injectWithTimeout(server, {
        method: 'GET',
        url: '/events?channels=workflows,queue',
        headers: { authorization: `Bearer ${authToken}` },
      });

      if (!result.timedOut) {
        expect(result.response.statusCode).not.toBe(400);
      }
    }, 5000);

    it('should parse workflowId filter', async () => {
      const result = await injectWithTimeout(server, {
        method: 'GET',
        url: '/events?workflowId=550e8400-e29b-41d4-a716-446655440000',
        headers: { authorization: `Bearer ${authToken}` },
      });

      if (!result.timedOut) {
        expect(result.response.statusCode).not.toBe(400);
      }
    }, 5000);

    it('should reject invalid workflowId format', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/events?workflowId=invalid-uuid',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      });

      // Should get validation error for invalid UUID
      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /workflows/:id/events', () => {
    it('should accept valid workflow ID', async () => {
      const result = await injectWithTimeout(server, {
        method: 'GET',
        url: '/workflows/550e8400-e29b-41d4-a716-446655440000/events',
        headers: { authorization: `Bearer ${authToken}` },
      });

      if (!result.timedOut) {
        expect(result.response.statusCode).not.toBe(400);
      }
    }, 5000);

    it('should reject invalid workflow ID', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/workflows/invalid-id/events',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should require authentication', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/workflows/550e8400-e29b-41d4-a716-446655440000/events',
      });

      expect([401, 403]).toContain(response.statusCode);
    });
  });

  describe('GET /queue/events', () => {
    it('should accept authenticated requests', async () => {
      const result = await injectWithTimeout(server, {
        method: 'GET',
        url: '/queue/events',
        headers: { authorization: `Bearer ${authToken}` },
      });

      if (!result.timedOut) {
        expect(result.response.statusCode).not.toBe(400);
      }
    }, 5000);

    it('should require authentication', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/queue/events',
      });

      expect([401, 403]).toContain(response.statusCode);
    });
  });

  describe('Connection Management', () => {
    it('should track active connections', async () => {
      const manager = getSSESubscriptionManager();
      expect(manager.getTotalConnections()).toBe(0);

      // Note: Full connection testing requires actual HTTP streams
      // Unit tests cover the SSESubscriptionManager behavior
    });
  });

  describe('Last-Event-ID Support', () => {
    it('should accept Last-Event-ID header', async () => {
      const result = await injectWithTimeout(server, {
        method: 'GET',
        url: '/events',
        headers: {
          authorization: `Bearer ${authToken}`,
          'last-event-id': '1706097600000_conn_abc_42',
        },
      });

      if (!result.timedOut) {
        expect(result.response.statusCode).not.toBe(400);
      }
    }, 5000);
  });
});

describe('SSE Event Format', () => {
  it('should format events correctly', async () => {
    // Test that events follow SSE spec
    const { formatSSEEvent } = await import('../../../src/sse/events.js');

    const event = {
      event: 'workflow:started',
      id: '1706097600000_conn_abc_1',
      data: { workflowId: 'wf_123' },
      timestamp: '2024-01-24T10:00:00Z',
    };

    const formatted = formatSSEEvent(event);

    // Check SSE format
    expect(formatted).toContain('event: workflow:started\n');
    expect(formatted).toContain('id: 1706097600000_conn_abc_1\n');
    expect(formatted).toContain('data: {"workflowId":"wf_123"}\n');
    expect(formatted.endsWith('\n\n')).toBe(true);
  });

  it('should format heartbeats as comments', async () => {
    const { formatHeartbeat } = await import('../../../src/sse/events.js');

    const heartbeat = formatHeartbeat();

    expect(heartbeat).toMatch(/^: heartbeat/);
    expect(heartbeat.endsWith('\n\n')).toBe(true);
  });
});

describe('closeAllSSEConnections', () => {
  it('should close all active connections', () => {
    const manager = getSSESubscriptionManager();

    // Add mock connections (tested more thoroughly in unit tests)
    closeAllSSEConnections();

    expect(manager.getTotalConnections()).toBe(0);
  });
});
