import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  CreateWorkflowRequestSchema,
  ListWorkflowsQuerySchema,
  WorkflowIdParamSchema,
} from '../types/index.js';
import { WorkflowService } from '../services/workflow-service.js';
import { requireRead, requireWrite } from '../auth/middleware.js';

/**
 * Setup workflow routes
 */
export async function setupWorkflowRoutes(
  server: FastifyInstance,
  workflowService: WorkflowService
): Promise<void> {
  // POST /workflows - Create and start a workflow
  server.post(
    '/workflows',
    {
      preHandler: [requireWrite('workflows')],
      schema: {
        description: 'Create and start a new workflow',
        tags: ['Workflows'],
        body: {
          type: 'object',
          properties: {
            definitionId: { type: 'string' },
            definition: { type: 'object' },
            context: { type: 'object' },
            metadata: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          required: ['context'],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = CreateWorkflowRequestSchema.parse(request.body);
      const workflow = await workflowService.create(body);

      return reply
        .status(201)
        .header('location', `/workflows/${workflow.id}`)
        .send(workflow);
    }
  );

  // GET /workflows - List workflows
  server.get(
    '/workflows',
    {
      preHandler: [requireRead('workflows')],
      schema: {
        description: 'List workflows',
        tags: ['Workflows'],
        querystring: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['created', 'running', 'paused', 'completed', 'cancelled', 'failed'],
            },
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = ListWorkflowsQuerySchema.parse(request.query);
      const result = await workflowService.list(query);
      return reply.send(result);
    }
  );

  // GET /workflows/:id - Get workflow details
  server.get(
    '/workflows/:id',
    {
      preHandler: [requireRead('workflows')],
      schema: {
        description: 'Get workflow details',
        tags: ['Workflows'],
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
      const params = WorkflowIdParamSchema.parse(request.params);
      const workflow = await workflowService.get(params.id);
      return reply.send(workflow);
    }
  );

  // POST /workflows/:id/pause - Pause workflow
  server.post(
    '/workflows/:id/pause',
    {
      preHandler: [requireWrite('workflows')],
      schema: {
        description: 'Pause a running workflow',
        tags: ['Workflows'],
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
      const params = WorkflowIdParamSchema.parse(request.params);
      const workflow = await workflowService.pause(params.id);
      return reply.send(workflow);
    }
  );

  // POST /workflows/:id/resume - Resume workflow
  server.post(
    '/workflows/:id/resume',
    {
      preHandler: [requireWrite('workflows')],
      schema: {
        description: 'Resume a paused workflow',
        tags: ['Workflows'],
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
      const params = WorkflowIdParamSchema.parse(request.params);
      const workflow = await workflowService.resume(params.id);
      return reply.send(workflow);
    }
  );

  // DELETE /workflows/:id - Cancel workflow
  server.delete(
    '/workflows/:id',
    {
      preHandler: [requireWrite('workflows')],
      schema: {
        description: 'Cancel a workflow',
        tags: ['Workflows'],
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
      const params = WorkflowIdParamSchema.parse(request.params);
      await workflowService.cancel(params.id);
      return reply.status(204).send();
    }
  );
}
