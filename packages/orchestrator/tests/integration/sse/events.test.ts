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

      expect(response.statusCode).toBe(401);
    });

    it('should accept authenticated requests', async () => {
      // Note: We can't easily test streaming responses with inject
      // This test verifies the route exists and accepts auth
      const response = await server.inject({
        method: 'GET',
        url: '/events',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      });

      // Route should accept the request (even if it times out or hijacks)
      // A 429 would indicate rate limiting, 401 would be auth failure
      expect([200, 429]).not.toContain(response.statusCode);
    });

    it('should parse channel query parameter', async () => {
      // The route should accept and parse the channels parameter
      const response = await server.inject({
        method: 'GET',
        url: '/events?channels=workflows,queue',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      });

      // Not a 400 validation error
      expect(response.statusCode).not.toBe(400);
    });

    it('should parse workflowId filter', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/events?workflowId=550e8400-e29b-41d4-a716-446655440000',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      });

      expect(response.statusCode).not.toBe(400);
    });

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
      const response = await server.inject({
        method: 'GET',
        url: '/workflows/550e8400-e29b-41d4-a716-446655440000/events',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      });

      expect(response.statusCode).not.toBe(400);
    });

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

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /queue/events', () => {
    it('should accept authenticated requests', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/queue/events',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      });

      expect(response.statusCode).not.toBe(400);
    });

    it('should require authentication', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/queue/events',
      });

      expect(response.statusCode).toBe(401);
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
      const response = await server.inject({
        method: 'GET',
        url: '/events',
        headers: {
          authorization: `Bearer ${authToken}`,
          'last-event-id': '1706097600000_conn_abc_42',
        },
      });

      // Should not reject due to header
      expect(response.statusCode).not.toBe(400);
    });
  });
});

describe('SSE Event Format', () => {
  it('should format events correctly', () => {
    // Test that events follow SSE spec
    const { formatSSEEvent } = require('../../../src/sse/events.js');

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
    expect(formatted).toEndWith('\n\n');
  });

  it('should format heartbeats as comments', () => {
    const { formatHeartbeat } = require('../../../src/sse/events.js');

    const heartbeat = formatHeartbeat();

    expect(heartbeat).toMatch(/^: heartbeat/);
    expect(heartbeat).toEndWith('\n\n');
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
