import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { setupConversationRoutes } from '../conversations.js';
import type { ConversationManager } from '../../conversation/conversation-manager.js';
import type { ConversationInfo } from '../../conversation/types.js';

// ---------------------------------------------------------------------------
// Mock ConversationManager
// ---------------------------------------------------------------------------
function createMockManager(): ConversationManager {
  return {
    start: vi.fn(),
    sendMessage: vi.fn(),
    end: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    stop: vi.fn(),
    setOutputCallback: vi.fn(),
  } as unknown as ConversationManager;
}

function makeInfo(overrides: Partial<ConversationInfo> = {}): ConversationInfo {
  return {
    conversationId: 'conv-1',
    workspaceId: 'primary',
    skipPermissions: true,
    startedAt: '2026-03-14T00:00:00.000Z',
    state: 'active',
    ...overrides,
  };
}

function makeError(message: string, statusCode: number): Error {
  const error = new Error(message);
  (error as any).statusCode = statusCode;
  return error;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Conversation routes', () => {
  let server: FastifyInstance;
  let manager: ConversationManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager = createMockManager();
    server = Fastify();
    server.decorate('config', { conversations: { maxConcurrent: 3 } });
    await setupConversationRoutes(server, manager);
    await server.ready();
  });

  describe('POST /conversations', () => {
    it('returns 201 with ConversationInfo on success', async () => {
      (manager.start as any).mockResolvedValue(makeInfo());

      const response = await server.inject({
        method: 'POST',
        url: '/conversations',
        payload: {
          conversationId: 'conv-1',
          workingDirectory: 'primary',
        },
      });

      expect(response.statusCode).toBe(201);
      expect(JSON.parse(response.body).conversationId).toBe('conv-1');
    });

    it('returns 400 for invalid request body', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/conversations',
        payload: { workingDirectory: 'primary' }, // missing conversationId
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).title).toBe('Bad Request');
    });

    it('returns 409 for duplicate conversation ID', async () => {
      (manager.start as any).mockRejectedValue(
        makeError('Conversation conv-1 already exists', 409),
      );

      const response = await server.inject({
        method: 'POST',
        url: '/conversations',
        payload: {
          conversationId: 'conv-1',
          workingDirectory: 'primary',
        },
      });

      expect(response.statusCode).toBe(409);
    });

    it('returns 429 when at max concurrency', async () => {
      (manager.start as any).mockRejectedValue(
        makeError('Max concurrent conversations reached', 429),
      );

      const response = await server.inject({
        method: 'POST',
        url: '/conversations',
        payload: {
          conversationId: 'conv-1',
          workingDirectory: 'primary',
        },
      });

      expect(response.statusCode).toBe(429);
    });

    it('returns 400 for invalid workspace', async () => {
      (manager.start as any).mockRejectedValue(
        makeError('Unknown workspace', 400),
      );

      const response = await server.inject({
        method: 'POST',
        url: '/conversations',
        payload: {
          conversationId: 'conv-1',
          workingDirectory: 'nonexistent',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /conversations/:id/message', () => {
    it('returns 202 on success', async () => {
      (manager.sendMessage as any).mockResolvedValue(undefined);

      const response = await server.inject({
        method: 'POST',
        url: '/conversations/conv-1/message',
        payload: { message: 'Hello!' },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.conversationId).toBe('conv-1');
      expect(body.accepted).toBe(true);
    });

    it('returns 400 for missing message', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/conversations/conv-1/message',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 404 for unknown conversation', async () => {
      (manager.sendMessage as any).mockRejectedValue(
        makeError('Conversation not found', 404),
      );

      const response = await server.inject({
        method: 'POST',
        url: '/conversations/unknown/message',
        payload: { message: 'Hello!' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 409 for non-active conversation', async () => {
      (manager.sendMessage as any).mockRejectedValue(
        makeError('Not active', 409),
      );

      const response = await server.inject({
        method: 'POST',
        url: '/conversations/conv-1/message',
        payload: { message: 'Hello!' },
      });

      expect(response.statusCode).toBe(409);
    });
  });

  describe('DELETE /conversations/:id', () => {
    it('returns 200 on success', async () => {
      (manager.end as any).mockResolvedValue(makeInfo({ state: 'ended' }));

      const response = await server.inject({
        method: 'DELETE',
        url: '/conversations/conv-1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.conversationId).toBe('conv-1');
      expect(body.state).toBe('ended');
    });

    it('returns 404 for unknown conversation', async () => {
      (manager.end as any).mockRejectedValue(
        makeError('Not found', 404),
      );

      const response = await server.inject({
        method: 'DELETE',
        url: '/conversations/unknown',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /conversations', () => {
    it('returns 200 with conversation list', async () => {
      (manager.list as any).mockReturnValue([makeInfo(), makeInfo({ conversationId: 'conv-2' })]);

      const response = await server.inject({
        method: 'GET',
        url: '/conversations',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.conversations).toHaveLength(2);
      expect(body.maxConcurrent).toBe(3);
    });

    it('returns empty list when no conversations', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/conversations',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.conversations).toHaveLength(0);
    });
  });
});
