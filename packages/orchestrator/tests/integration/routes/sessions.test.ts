import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { SessionReader } from '../../../src/services/session-reader.js';

// Fixture: a minimal JSONL session file
function makeFixture() {
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-03-19T10:00:00.000Z',
      message: { role: 'user', content: 'Help me fix a bug' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      timestamp: '2026-03-19T10:00:05.000Z',
      slug: 'partitioned-forest',
      gitBranch: 'main',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll look into it." },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/src/app.ts' } },
        ],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 500, output_tokens: 200 },
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'u2',
      parentUuid: 'a1',
      timestamp: '2026-03-19T10:00:06.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents here', is_error: false },
        ],
      },
    }),
    JSON.stringify({
      type: 'queue-operation',
      uuid: 'q1',
      timestamp: '2026-03-19T10:00:07.000Z',
      message: { role: 'user', content: '' },
    }),
  ];
  return lines.join('\n');
}

describe('Session Routes', () => {
  let server: FastifyInstance;
  let tempDir: string;

  beforeAll(async () => {
    // Create temp projects dir with a session fixture
    tempDir = join(tmpdir(), `session-routes-test-${Date.now()}`);
    const fixtureDir = join(tempDir, '-workspaces-myproject');
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(join(fixtureDir, 'session-abc.jsonl'), makeFixture());

    // Create a lightweight Fastify server (avoids importing server.ts with heavy deps)
    server = Fastify({ logger: false });

    const workspaces: Record<string, string> = { myproject: '/workspaces/myproject' };
    const reader = new SessionReader(tempDir);

    // Mock ConversationManager with isSessionActive
    const mockManager = {
      isSessionActive(sessionId: string): boolean {
        return sessionId === 'active-session';
      },
    };

    server.get(
      '/sessions/:sessionId',
      async (request: any, reply: any) => {
        const { sessionId } = request.params;
        const { workspace } = request.query;

        try {
          const filePath = await reader.findSessionFile(sessionId, workspace, workspaces);
          const response = await reader.parseSessionFile(filePath, sessionId);
          response.metadata.isActive = mockManager.isSessionActive(sessionId);
          return reply.status(200).send(response);
        } catch (error: any) {
          const status = error.statusCode ?? 500;
          return reply.status(status).send({
            type: 'about:blank',
            title: status === 404 ? 'Not Found' : status === 400 ? 'Bad Request' : 'Internal Server Error',
            status,
            detail: error.message,
          });
        }
      },
    );

    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('GET /sessions/:sessionId', () => {
    it('should return 200 with correct message structure and metadata', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/sessions/session-abc',
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.metadata).toBeDefined();
      expect(body.metadata.sessionId).toBe('session-abc');
      expect(body.metadata.slug).toBe('partitioned-forest');
      expect(body.metadata.branch).toBe('main');
      expect(body.metadata.model).toBe('claude-sonnet-4-20250514');
      expect(body.metadata.totalInputTokens).toBe(500);
      expect(body.metadata.totalOutputTokens).toBe(200);
      expect(body.metadata.isActive).toBe(false);

      expect(body.messages).toBeDefined();
      expect(Array.isArray(body.messages)).toBe(true);

      // 1 user + 1 assistant + 1 tool_result = 3 (queue-operation excluded)
      expect(body.messages).toHaveLength(3);
      expect(body.messages[0].role).toBe('user');
      expect(body.messages[1].role).toBe('assistant');
      expect(body.messages[2].role).toBe('tool_result');
      expect(body.metadata.messageCount).toBe(3);
    });

    it('should return 404 for unknown session ID', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/sessions/nonexistent-session',
      });

      expect(response.statusCode).toBe(404);

      const body = JSON.parse(response.payload);
      expect(body.title).toBe('Not Found');
      expect(body.detail).toContain('not found');
    });

    it('should support workspace-scoped lookup via query parameter', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/sessions/session-abc?workspace=myproject',
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.metadata.sessionId).toBe('session-abc');
    });

    it('should return 400 for invalid workspace', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/sessions/session-abc?workspace=invalid-ws',
      });

      expect(response.statusCode).toBe(400);

      const body = JSON.parse(response.payload);
      expect(body.title).toBe('Bad Request');
      expect(body.detail).toContain('Unknown workspace');
    });

    it('should include tool_use blocks in assistant messages', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/sessions/session-abc',
      });

      const body = JSON.parse(response.payload);
      const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
      expect(assistantMsg.content).toHaveLength(2);
      expect(assistantMsg.content[0].type).toBe('text');
      expect(assistantMsg.content[1].type).toBe('tool_use');
      expect(assistantMsg.content[1].name).toBe('Read');
    });

    it('should promote tool_result from user entries to separate messages', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/sessions/session-abc',
      });

      const body = JSON.parse(response.payload);
      const toolResultMsg = body.messages.find((m: any) => m.role === 'tool_result');
      expect(toolResultMsg).toBeDefined();
      expect(toolResultMsg.content[0].type).toBe('tool_result');
      expect(toolResultMsg.content[0].tool_use_id).toBe('tool-1');
    });

    it('should set isActive from ConversationManager mock', async () => {
      // session-abc is not in mock's active list, so isActive should be false
      const response = await server.inject({
        method: 'GET',
        url: '/sessions/session-abc',
      });

      const body = JSON.parse(response.payload);
      expect(body.metadata.isActive).toBe(false);
    });
  });
});
