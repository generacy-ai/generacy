import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AgentRegistry } from '../services/agent-registry.js';
import { requireRead } from '../auth/middleware.js';

/**
 * Setup agent routes
 */
export async function setupAgentRoutes(
  server: FastifyInstance,
  agentRegistry: AgentRegistry
): Promise<void> {
  // GET /agents - List connected agents
  server.get(
    '/agents',
    {
      preHandler: [requireRead('agents')],
      schema: {
        description: 'List connected agents',
        tags: ['Agents'],
        querystring: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['connected', 'idle', 'busy', 'disconnected'],
            },
            type: {
              type: 'string',
              enum: ['claude', 'gpt4', 'custom'],
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { status?: string; type?: string };

      let agents = agentRegistry.list();

      // Filter by status
      if (query.status) {
        agents = agents.filter((a) => a.status === query.status);
      }

      // Filter by type
      if (query.type) {
        agents = agents.filter((a) => a.type === query.type);
      }

      return reply.send(agents);
    }
  );

  // GET /agents/:id - Get agent details
  server.get(
    '/agents/:id',
    {
      preHandler: [requireRead('agents')],
      schema: {
        description: 'Get agent details',
        tags: ['Agents'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { id: string };
      const agent = agentRegistry.get(params.id);

      if (!agent) {
        return reply.status(404).send({
          type: 'urn:generacy:error:not-found',
          title: 'Not Found',
          status: 404,
          detail: `Agent ${params.id} not found`,
          traceId: request.correlationId,
        });
      }

      return reply.send(agent);
    }
  );

  // GET /agents/stats - Get agent statistics
  server.get(
    '/agents/stats',
    {
      preHandler: [requireRead('agents')],
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const stats = agentRegistry.getStats();
      return reply.send({
        total: agentRegistry.size(),
        byStatus: stats,
      });
    }
  );
}
