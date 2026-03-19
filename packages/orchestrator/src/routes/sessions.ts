import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ListSessionsQuerySchema } from '../types/index.js';
import type { SessionService } from '../services/session-service.js';
import { requireRead } from '../auth/middleware.js';

/**
 * Setup session routes
 */
export async function setupSessionRoutes(
  server: FastifyInstance,
  sessionService: SessionService,
): Promise<void> {
  // GET /sessions - List Claude Code sessions
  server.get(
    '/sessions',
    {
      preHandler: [requireRead('sessions')],
      schema: {
        description: 'List Claude Code sessions',
        tags: ['Sessions'],
        querystring: {
          type: 'object',
          properties: {
            workspace: { type: 'string' },
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = ListSessionsQuerySchema.parse(request.query);
      const result = await sessionService.list(query);
      return reply.send(result);
    },
  );
}
