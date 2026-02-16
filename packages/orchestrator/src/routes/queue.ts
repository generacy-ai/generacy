import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  QueueQuerySchema,
  DecisionIdParamSchema,
  DecisionResponseRequestSchema,
  CreateDecisionRequestSchema,
} from '../types/index.js';
import { QueueService } from '../services/queue-service.js';
import { requireRead, requireWrite } from '../auth/middleware.js';
import { getSSESubscriptionManager } from '../sse/subscriptions.js';
import { createQueueEvent } from '../sse/events.js';

/**
 * Setup queue routes
 */
export async function setupQueueRoutes(
  server: FastifyInstance,
  queueService: QueueService
): Promise<void> {
  // GET /queue - Get decision queue
  server.get(
    '/queue',
    {
      preHandler: [requireRead('queue')],
      schema: {
        description: 'Get decision queue',
        tags: ['Queue'],
        querystring: {
          type: 'object',
          properties: {
            priority: {
              type: 'string',
              enum: ['blocking_now', 'blocking_soon', 'when_available'],
            },
            workflowId: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = QueueQuerySchema.parse(request.query);
      const items = await queueService.getQueue(query);
      return reply.send(items);
    }
  );

  // POST /queue - Create a new decision
  server.post(
    '/queue',
    {
      preHandler: [requireWrite('queue')],
      schema: {
        description: 'Create a new decision in the queue',
        tags: ['Queue'],
        // Body validation done by Zod in handler to support defaults and coercion
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = CreateDecisionRequestSchema.parse(request.body);
      const item = await queueService.createDecision(body);

      // Broadcast queue:item:added SSE event
      const queue = await queueService.getQueue();
      const manager = getSSESubscriptionManager();
      const event = createQueueEvent('added', [item], queue.length, 'internal', Date.now());
      manager.broadcast('queue', event);

      return reply.status(201).send(item);
    }
  );

  // GET /queue/:id - Get specific decision
  server.get(
    '/queue/:id',
    {
      preHandler: [requireRead('queue')],
      schema: {
        description: 'Get decision details',
        tags: ['Queue'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
          required: ['id'],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = DecisionIdParamSchema.parse(request.params);
      const decision = await queueService.getDecision(params.id);
      return reply.send(decision);
    }
  );

  // POST /queue/:id/respond - Submit decision response
  server.post(
    '/queue/:id/respond',
    {
      preHandler: [requireWrite('queue')],
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
          required: ['id'],
        },
        // Body validation done by Zod in handler to support complex union types
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = DecisionIdParamSchema.parse(request.params);
      const body = DecisionResponseRequestSchema.parse(request.body);

      // Fetch the decision item before responding (respond removes it from the queue)
      const item = await queueService.getDecision(params.id);

      const response = await queueService.respond(
        params.id,
        body,
        request.auth.userId
      );

      // Broadcast queue:item:removed SSE event with the response included
      const queue = await queueService.getQueue();
      const manager = getSSESubscriptionManager();
      const event = createQueueEvent('removed', [item], queue.length, 'internal', Date.now(), response);
      manager.broadcast('queue', event);

      return reply.send(response);
    }
  );

  // GET /queue/stats - Get queue statistics
  server.get(
    '/queue/stats',
    {
      preHandler: [requireRead('queue')],
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const stats = await queueService.getQueueStats();
      return reply.send(stats);
    }
  );
}
