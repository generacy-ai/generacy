import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { QueueManager } from '../types/index.js';
import { requireRead } from '../auth/middleware.js';

const QueueItemsQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

/**
 * Setup dispatch queue routes for monitoring queue status.
 * Separate from the decision queue routes (/queue).
 */
export async function setupDispatchRoutes(
  server: FastifyInstance,
  queueManager: QueueManager,
): Promise<void> {
  // GET /dispatch/queue/depth
  server.get(
    '/dispatch/queue/depth',
    {
      preHandler: [requireRead('queue')],
      schema: {},
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const depth = await queueManager.getQueueDepth();
      return reply.send({ depth });
    },
  );

  // GET /dispatch/queue/items
  server.get(
    '/dispatch/queue/items',
    {
      preHandler: [requireRead('queue')],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            offset: { type: 'number', default: 0 },
            limit: { type: 'number', default: 10 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = QueueItemsQuerySchema.parse(request.query);
      const items = await queueManager.getQueueItems(query.offset, query.limit);
      return reply.send({ items, offset: query.offset, limit: query.limit });
    },
  );

  // GET /dispatch/queue/workers
  server.get(
    '/dispatch/queue/workers',
    {
      preHandler: [requireRead('queue')],
      schema: {},
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const count = await queueManager.getActiveWorkerCount();
      return reply.send({ count });
    },
  );
}
