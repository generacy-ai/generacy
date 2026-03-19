import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ListSessionsQuerySchema } from '../types/index.js';
import type { SessionService } from '../services/session-service.js';
import { requireRead } from '../auth/middleware.js';
import type { ConversationManager } from '../conversation/conversation-manager.js';
import { SessionReader, SessionParamsSchema, SessionQuerySchema } from '../services/session-reader.js';

/**
 * Setup session list routes (GET /sessions)
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

/**
 * Setup session detail routes (GET /sessions/:sessionId)
 */
export async function setupSessionDetailRoutes(
  server: FastifyInstance,
  manager?: ConversationManager | null,
): Promise<void> {
  const reader = new SessionReader();

  // GET /sessions/:sessionId — return full session conversation history
  server.get(
    '/sessions/:sessionId',
    async (request: FastifyRequest<{ Params: { sessionId: string }; Querystring: { workspace?: string } }>, reply: FastifyReply) => {
      // Validate path params
      const paramsParsed = SessionParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: paramsParsed.error.issues.map((i) => i.message).join('; '),
        });
      }

      // Validate query params
      const queryParsed = SessionQuerySchema.safeParse(request.query);
      if (!queryParsed.success) {
        return reply.status(400).send({
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: queryParsed.error.issues.map((i) => i.message).join('; '),
        });
      }

      const { sessionId } = paramsParsed.data;
      const { workspace } = queryParsed.data;
      const workspaces = (server as any).config?.conversations?.workspaces as Record<string, string> | undefined;

      try {
        const filePath = await reader.findSessionFile(sessionId, workspace, workspaces);
        const response = await reader.parseSessionFile(filePath, sessionId);

        // Set isActive from ConversationManager
        if (manager) {
          response.metadata.isActive = manager.isSessionActive(sessionId);
        }

        return reply.status(200).send(response);
      } catch (error: any) {
        const status = error.statusCode ?? 500;
        return reply.status(status).send({
          type: 'about:blank',
          title: statusTitle(status),
          status,
          detail: error.message,
        });
      }
    },
  );
}

function statusTitle(status: number): string {
  switch (status) {
    case 400: return 'Bad Request';
    case 404: return 'Not Found';
    default: return 'Internal Server Error';
  }
}
