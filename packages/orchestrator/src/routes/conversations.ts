import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ConversationStartSchema, ConversationMessageSchema } from '../conversation/types.js';
import type { ConversationManager } from '../conversation/conversation-manager.js';

/**
 * Setup conversation REST API routes.
 */
export async function setupConversationRoutes(
  server: FastifyInstance,
  manager: ConversationManager,
): Promise<void> {
  // POST /conversations — start a new conversation
  server.post(
    '/conversations',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ConversationStartSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: parsed.error.issues.map((i) => i.message).join('; '),
        });
      }

      try {
        const info = await manager.start(parsed.data);
        return reply.status(201).send(info);
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

  // POST /conversations/:id/message — send a message
  server.post(
    '/conversations/:id/message',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = ConversationMessageSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: parsed.error.issues.map((i) => i.message).join('; '),
        });
      }

      try {
        await manager.sendMessage(request.params.id, parsed.data.message);
        return reply.status(202).send({
          conversationId: request.params.id,
          accepted: true,
        });
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

  // DELETE /conversations/:id — end a conversation
  server.delete(
    '/conversations/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const info = await manager.end(request.params.id);
        return reply.status(200).send({
          conversationId: info.conversationId,
          state: info.state,
        });
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

  // GET /conversations — list active conversations
  server.get(
    '/conversations',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const conversations = manager.list();
      return reply.status(200).send({
        conversations,
        maxConcurrent: (server as any).config?.conversations?.maxConcurrent ?? 3,
      });
    },
  );
}

function statusTitle(status: number): string {
  switch (status) {
    case 400: return 'Bad Request';
    case 404: return 'Not Found';
    case 409: return 'Conflict';
    case 429: return 'Too Many Requests';
    default: return 'Internal Server Error';
  }
}
