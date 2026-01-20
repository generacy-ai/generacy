import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Integration, IntegrationStatus } from '../types/index.js';
import { requireRead } from '../auth/middleware.js';

/**
 * Integration registry interface
 */
export interface IntegrationRegistry {
  getAll(): Promise<Integration[]>;
  get(id: string): Promise<Integration | null>;
}

/**
 * In-memory integration registry for development/testing
 */
export class InMemoryIntegrationRegistry implements IntegrationRegistry {
  private integrations: Map<string, Integration> = new Map();

  async getAll(): Promise<Integration[]> {
    return Array.from(this.integrations.values());
  }

  async get(id: string): Promise<Integration | null> {
    return this.integrations.get(id) ?? null;
  }

  /**
   * Add an integration (for testing)
   */
  add(integration: Integration): void {
    this.integrations.set(integration.id, integration);
  }

  /**
   * Update integration status
   */
  updateStatus(id: string, status: 'connected' | 'disconnected' | 'error', error?: string): boolean {
    const integration = this.integrations.get(id);
    if (!integration) return false;

    integration.status = status;
    integration.error = error ?? null;
    if (status === 'connected') {
      integration.lastSync = new Date().toISOString();
    }
    return true;
  }

  /**
   * Clear all integrations (for testing)
   */
  clear(): void {
    this.integrations.clear();
  }
}

/**
 * Setup integration routes
 */
export async function setupIntegrationRoutes(
  server: FastifyInstance,
  integrationRegistry: IntegrationRegistry
): Promise<void> {
  // GET /integrations - Get integration status
  server.get(
    '/integrations',
    {
      preHandler: [requireRead('agents')], // Using agents scope for integrations
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const integrations = await integrationRegistry.getAll();
      const response: IntegrationStatus = { integrations };
      return reply.send(response);
    }
  );

  // GET /integrations/:id - Get specific integration
  server.get(
    '/integrations/:id',
    {
      preHandler: [requireRead('agents')],
      schema: {
        description: 'Get integration details',
        tags: ['Integrations'],
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
      const integration = await integrationRegistry.get(params.id);

      if (!integration) {
        return reply.status(404).send({
          type: 'urn:generacy:error:not-found',
          title: 'Not Found',
          status: 404,
          detail: `Integration ${params.id} not found`,
          traceId: request.correlationId,
        });
      }

      return reply.send(integration);
    }
  );
}
