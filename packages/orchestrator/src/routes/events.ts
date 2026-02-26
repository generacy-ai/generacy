import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { SSEQuerySchema, parseChannels, type SSEChannel } from '../types/sse.js';
import { createSSEStream, parseLastEventId } from '../sse/stream.js';
import {
  getSSESubscriptionManager,
  type SSESubscriptionManager,
} from '../sse/subscriptions.js';
import { requireRead } from '../auth/middleware.js';

/**
 * SSE connection tracking for graceful shutdown
 */
const activeConnections: Set<string> = new Set();

/**
 * Get active connection count
 */
export function getActiveConnectionCount(): number {
  return activeConnections.size;
}

/**
 * Close all active SSE connections (for graceful shutdown)
 */
export function closeAllSSEConnections(): void {
  const manager = getSSESubscriptionManager();
  manager.closeAll();
  activeConnections.clear();
}

/**
 * Setup SSE event routes
 */
export async function setupEventsRoutes(server: FastifyInstance): Promise<void> {
  const subscriptionManager = getSSESubscriptionManager();

  // GET /events - Global event stream (all channels)
  server.get(
    '/events',
    {
      preHandler: [requireRead('workflows')],
      schema: {
        description: 'Subscribe to real-time events via Server-Sent Events',
        tags: ['Events'],
        querystring: {
          type: 'object',
          properties: {
            channels: {
              type: 'string',
              description: 'Comma-separated list of channels (workflows, queue, agents)',
            },
            workflowId: {
              type: 'string',
              format: 'uuid',
              description: 'Filter events to specific workflow',
            },
          },
        },
        headers: {
          type: 'object',
          properties: {
            'last-event-id': {
              type: 'string',
              description: 'Resume from last event ID (for reconnection)',
            },
          },
        },
        response: {
          200: {
            type: 'string',
            description: 'SSE event stream',
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      return handleSSEConnection(request, reply, subscriptionManager);
    }
  );

  // GET /workflows/:id/events - Workflow-specific event stream
  server.get(
    '/workflows/:id/events',
    {
      preHandler: [requireRead('workflows')],
      schema: {
        description: 'Subscribe to events for a specific workflow',
        tags: ['Events', 'Workflows'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
          required: ['id'],
        },
        headers: {
          type: 'object',
          properties: {
            'last-event-id': {
              type: 'string',
              description: 'Resume from last event ID',
            },
          },
        },
        response: {
          200: {
            type: 'string',
            description: 'SSE event stream',
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);

      return handleSSEConnection(request, reply, subscriptionManager, {
        channels: ['workflows'],
        filters: { workflowId: params.id },
      });
    }
  );

  // GET /queue/events - Queue event stream
  server.get(
    '/queue/events',
    {
      preHandler: [requireRead('queue')],
      schema: {
        description: 'Subscribe to queue update events',
        tags: ['Events', 'Queue'],
        headers: {
          type: 'object',
          properties: {
            'last-event-id': {
              type: 'string',
              description: 'Resume from last event ID',
            },
          },
        },
        response: {
          200: {
            type: 'string',
            description: 'SSE event stream',
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      return handleSSEConnection(request, reply, subscriptionManager, {
        channels: ['queue'],
      });
    }
  );
}

/**
 * Handle SSE connection setup and management
 */
async function handleSSEConnection(
  request: FastifyRequest,
  reply: FastifyReply,
  subscriptionManager: SSESubscriptionManager,
  overrides?: {
    channels?: SSEChannel[];
    filters?: { workflowId?: string };
  }
): Promise<void> {
  // Validate auth
  if (!request.auth || request.auth.userId === 'anonymous') {
    return reply.status(401).send({
      type: 'https://api.generacy.ai/problems/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'SSE connections require authentication',
      traceId: request.correlationId,
    });
  }

  // Parse query parameters
  const query = SSEQuerySchema.safeParse(request.query);
  if (!query.success) {
    return reply.status(400).send({
      type: 'https://api.generacy.ai/problems/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: 'Invalid query parameters',
      errors: query.error.errors,
      traceId: request.correlationId,
    });
  }

  // Determine channels and filters
  const channels = overrides?.channels || parseChannels(query.data.channels);
  const filters = overrides?.filters || { workflowId: query.data.workflowId };

  // Parse Last-Event-ID for reconnection
  const lastEventId = parseLastEventId(request);

  // Check connection limits
  const userConnections = subscriptionManager.getUserConnections(request.auth.userId);
  if (userConnections.length >= 3) {
    return reply.status(429).send({
      type: 'https://api.generacy.ai/problems/rate-limit',
      title: 'Too Many Connections',
      status: 429,
      detail: 'Maximum of 3 concurrent SSE connections per user',
      traceId: request.correlationId,
    });
  }

  // Create SSE stream
  const stream = createSSEStream(reply, request, request.auth.userId, {
    channels,
    filters,
    lastEventId: lastEventId
      ? `${lastEventId.timestamp}_${lastEventId.connectionId}_${lastEventId.sequence}`
      : undefined,
  });

  // Try to add connection
  if (!subscriptionManager.addConnection(stream)) {
    stream.close();
    return reply.status(429).send({
      type: 'https://api.generacy.ai/problems/rate-limit',
      title: 'Too Many Connections',
      status: 429,
      detail: 'Connection limit exceeded',
      traceId: request.correlationId,
    });
  }

  // Track connection
  activeConnections.add(stream.id);

  // Log connection
  request.log.info(
    {
      connectionId: stream.id,
      userId: request.auth.userId,
      channels,
      filters,
      correlationId: request.correlationId,
    },
    'SSE connection established'
  );

  // Start the stream
  stream.start();

  // Replay missed events if reconnecting
  if (lastEventId) {
    const replayedCount = subscriptionManager.replayMissedEvents(stream);
    if (replayedCount > 0) {
      request.log.info(
        {
          connectionId: stream.id,
          replayedCount,
          lastEventId: `${lastEventId.timestamp}_${lastEventId.connectionId}_${lastEventId.sequence}`,
        },
        'Replayed missed events'
      );
    }
  }

  // Handle client disconnect
  request.raw.on('close', () => {
    request.log.info(
      {
        connectionId: stream.id,
        userId: request.auth.userId,
        correlationId: request.correlationId,
      },
      'SSE connection closed'
    );

    subscriptionManager.removeConnection(stream.id);
    activeConnections.delete(stream.id);
  });

  // Handle errors
  request.raw.on('error', (error) => {
    request.log.error(
      {
        err: error,
        connectionId: stream.id,
        userId: request.auth.userId,
        correlationId: request.correlationId,
      },
      'SSE connection error'
    );

    subscriptionManager.removeConnection(stream.id);
    activeConnections.delete(stream.id);
  });

  // Prevent Fastify from sending a response (we're handling it manually)
  reply.hijack();
}
