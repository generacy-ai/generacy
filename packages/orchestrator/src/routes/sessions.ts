import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ConversationManager } from '../conversation/conversation-manager.js';
import { SessionReader, SessionParamsSchema, SessionQuerySchema } from '../services/session-reader.js';

/**
 * Setup session REST API routes.
 */
export async function setupSessionRoutes(
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
