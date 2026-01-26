/**
 * Unit tests for the HTTP router utilities.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  pathToRegex,
  createRouter,
  parseJsonBody,
  sendJson,
  sendError,
} from '../router.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

describe('Router utilities', () => {
  describe('pathToRegex', () => {
    it('should convert simple path to regex', () => {
      const result = pathToRegex('/api/health');
      expect(result.regex.test('/api/health')).toBe(true);
      expect(result.paramNames).toEqual([]);
    });

    it('should not match different paths', () => {
      const result = pathToRegex('/api/health');
      expect(result.regex.test('/api/status')).toBe(false);
      expect(result.regex.test('/api/health/')).toBe(false);
      expect(result.regex.test('/api/health/extra')).toBe(false);
    });

    it('should convert path with single param', () => {
      const result = pathToRegex('/api/workers/:id');
      expect(result.regex.test('/api/workers/abc123')).toBe(true);
      expect(result.regex.test('/api/workers/test-worker')).toBe(true);
      expect(result.paramNames).toEqual(['id']);
    });

    it('should extract parameter value with capture group', () => {
      const result = pathToRegex('/api/workers/:id');
      const match = '/api/workers/abc123'.match(result.regex);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('abc123');
    });

    it('should convert path with param in middle', () => {
      const result = pathToRegex('/api/jobs/:id/result');
      expect(result.regex.test('/api/jobs/job-123/result')).toBe(true);
      expect(result.regex.test('/api/jobs/abc/result')).toBe(true);
      expect(result.paramNames).toEqual(['id']);
    });

    it('should not match path with param when extra segments exist', () => {
      const result = pathToRegex('/api/jobs/:id/result');
      expect(result.regex.test('/api/jobs/job-123/result/extra')).toBe(false);
    });

    it('should handle multiple parameters', () => {
      const result = pathToRegex('/api/users/:userId/posts/:postId');
      expect(result.regex.test('/api/users/user1/posts/post1')).toBe(true);
      expect(result.paramNames).toEqual(['userId', 'postId']);

      const match = '/api/users/user1/posts/post1'.match(result.regex);
      expect(match![1]).toBe('user1');
      expect(match![2]).toBe('post1');
    });

    it('should escape special regex characters in path', () => {
      const result = pathToRegex('/api/test.endpoint');
      expect(result.regex.test('/api/test.endpoint')).toBe(true);
      expect(result.regex.test('/api/testXendpoint')).toBe(false);
    });

    it('should handle underscore in parameter names', () => {
      const result = pathToRegex('/api/workers/:worker_id');
      expect(result.regex.test('/api/workers/abc123')).toBe(true);
      expect(result.paramNames).toEqual(['worker_id']);
    });

    it('should handle numeric characters in parameter names', () => {
      const result = pathToRegex('/api/v2/:id1');
      expect(result.regex.test('/api/v2/value')).toBe(true);
      expect(result.paramNames).toEqual(['id1']);
    });
  });

  describe('createRouter', () => {
    it('should match route by method and path', () => {
      const router = createRouter([
        {
          method: 'GET',
          pattern: /^\/api\/health$/,
          handler: 'healthCheck',
        },
      ]);

      const match = router('GET', '/api/health');
      expect(match).toEqual({ handler: 'healthCheck', params: {} });
    });

    it('should return null for unmatched path', () => {
      const router = createRouter([
        {
          method: 'GET',
          pattern: /^\/api\/health$/,
          handler: 'healthCheck',
        },
      ]);

      const match = router('GET', '/api/status');
      expect(match).toBeNull();
    });

    it('should return null for unmatched method', () => {
      const router = createRouter([
        {
          method: 'GET',
          pattern: /^\/api\/health$/,
          handler: 'healthCheck',
        },
      ]);

      const match = router('POST', '/api/health');
      expect(match).toBeNull();
    });

    it('should extract path parameters', () => {
      const router = createRouter([
        {
          method: 'DELETE',
          pattern: /^\/api\/workers\/([^/]+)$/,
          handler: 'unregisterWorker',
          paramNames: ['id'],
        },
      ]);

      const match = router('DELETE', '/api/workers/abc123');
      expect(match).toEqual({
        handler: 'unregisterWorker',
        params: { id: 'abc123' },
      });
    });

    it('should extract multiple path parameters', () => {
      const router = createRouter([
        {
          method: 'GET',
          pattern: /^\/api\/users\/([^/]+)\/posts\/([^/]+)$/,
          handler: 'getUserPost',
          paramNames: ['userId', 'postId'],
        },
      ]);

      const match = router('GET', '/api/users/user1/posts/post1');
      expect(match).toEqual({
        handler: 'getUserPost',
        params: { userId: 'user1', postId: 'post1' },
      });
    });

    it('should match correct route when multiple routes exist', () => {
      const router = createRouter([
        {
          method: 'GET',
          pattern: /^\/api\/workers$/,
          handler: 'listWorkers',
        },
        {
          method: 'POST',
          pattern: /^\/api\/workers\/register$/,
          handler: 'registerWorker',
        },
        {
          method: 'DELETE',
          pattern: /^\/api\/workers\/([^/]+)$/,
          handler: 'unregisterWorker',
          paramNames: ['id'],
        },
        {
          method: 'GET',
          pattern: /^\/api\/workers\/([^/]+)$/,
          handler: 'getWorker',
          paramNames: ['id'],
        },
      ]);

      expect(router('GET', '/api/workers')).toEqual({
        handler: 'listWorkers',
        params: {},
      });
      expect(router('POST', '/api/workers/register')).toEqual({
        handler: 'registerWorker',
        params: {},
      });
      expect(router('DELETE', '/api/workers/abc123')).toEqual({
        handler: 'unregisterWorker',
        params: { id: 'abc123' },
      });
      expect(router('GET', '/api/workers/xyz789')).toEqual({
        handler: 'getWorker',
        params: { id: 'xyz789' },
      });
    });

    it('should match first matching route when order matters', () => {
      const router = createRouter([
        {
          method: 'GET',
          pattern: /^\/api\/workers\/special$/,
          handler: 'specialWorker',
        },
        {
          method: 'GET',
          pattern: /^\/api\/workers\/([^/]+)$/,
          handler: 'getWorker',
          paramNames: ['id'],
        },
      ]);

      // 'special' should match the first route, not the parameterized one
      expect(router('GET', '/api/workers/special')).toEqual({
        handler: 'specialWorker',
        params: {},
      });
    });

    it('should return empty params when route has no paramNames', () => {
      const router = createRouter([
        {
          method: 'GET',
          pattern: /^\/api\/test$/,
          handler: 'test',
          // paramNames intentionally omitted
        },
      ]);

      const match = router('GET', '/api/test');
      expect(match).toEqual({ handler: 'test', params: {} });
    });

    it('should return null for empty routes array', () => {
      const router = createRouter([]);
      expect(router('GET', '/api/anything')).toBeNull();
    });

    it('should integrate with pathToRegex', () => {
      const workerPath = pathToRegex('/api/workers/:id');
      const router = createRouter([
        {
          method: 'GET',
          pattern: workerPath.regex,
          handler: 'getWorker',
          paramNames: workerPath.paramNames,
        },
      ]);

      const match = router('GET', '/api/workers/test-worker-123');
      expect(match).toEqual({
        handler: 'getWorker',
        params: { id: 'test-worker-123' },
      });
    });
  });

  describe('parseJsonBody', () => {
    /**
     * Create a mock request using EventEmitter that emits data and end events
     */
    function createMockRequest(body: string): IncomingMessage {
      const req = new EventEmitter() as IncomingMessage;
      process.nextTick(() => {
        if (body) {
          req.emit('data', body);
        }
        req.emit('end');
      });
      return req;
    }

    it('should parse valid JSON body', async () => {
      const req = createMockRequest('{"name":"test","value":123}');
      const result = await parseJsonBody<{ name: string; value: number }>(req);
      expect(result).toEqual({ name: 'test', value: 123 });
    });

    it('should return empty object for empty body', async () => {
      const req = createMockRequest('');
      const result = await parseJsonBody(req);
      expect(result).toEqual({});
    });

    it('should throw error for invalid JSON', async () => {
      const req = createMockRequest('not valid json');
      await expect(parseJsonBody(req)).rejects.toThrow('Invalid JSON');
    });

    it('should throw error for malformed JSON', async () => {
      const req = createMockRequest('{"name": "test",}');
      await expect(parseJsonBody(req)).rejects.toThrow('Invalid JSON');
    });

    it('should parse array JSON body', async () => {
      const req = createMockRequest('[1, 2, 3]');
      const result = await parseJsonBody<number[]>(req);
      expect(result).toEqual([1, 2, 3]);
    });

    it('should parse nested JSON body', async () => {
      const req = createMockRequest(
        '{"user":{"name":"test","roles":["admin","user"]}}'
      );
      const result = await parseJsonBody<{
        user: { name: string; roles: string[] };
      }>(req);
      expect(result).toEqual({
        user: { name: 'test', roles: ['admin', 'user'] },
      });
    });

    it('should handle multiple data chunks', async () => {
      const req = new EventEmitter() as IncomingMessage;
      process.nextTick(() => {
        req.emit('data', '{"na');
        req.emit('data', 'me":"');
        req.emit('data', 'chunked"}');
        req.emit('end');
      });

      const result = await parseJsonBody<{ name: string }>(req);
      expect(result).toEqual({ name: 'chunked' });
    });

    it('should handle Buffer data', async () => {
      const req = new EventEmitter() as IncomingMessage;
      process.nextTick(() => {
        req.emit('data', Buffer.from('{"type":"buffer"}'));
        req.emit('end');
      });

      const result = await parseJsonBody<{ type: string }>(req);
      expect(result).toEqual({ type: 'buffer' });
    });

    it('should reject on request error', async () => {
      const req = new EventEmitter() as IncomingMessage;
      const testError = new Error('Connection reset');
      process.nextTick(() => {
        req.emit('error', testError);
      });

      await expect(parseJsonBody(req)).rejects.toThrow('Connection reset');
    });
  });

  describe('sendJson', () => {
    /**
     * Create a mock response object that captures writeHead and end calls
     */
    function createMockResponse(): ServerResponse & {
      headers: Record<string, string>;
      body: string;
      statusCode: number;
    } {
      const res = {
        headers: {} as Record<string, string>,
        body: '',
        statusCode: 0,
        writeHead: vi.fn((status: number, headers: Record<string, string>) => {
          res.statusCode = status;
          res.headers = headers;
          return res;
        }),
        end: vi.fn((data: string) => {
          res.body = data;
        }),
      };
      return res as unknown as ServerResponse & {
        headers: Record<string, string>;
        body: string;
        statusCode: number;
      };
    }

    it('should send JSON response with correct status', () => {
      const res = createMockResponse();
      sendJson(res, 200, { workerId: 'abc123' });

      expect(res.statusCode).toBe(200);
      expect(res.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(res.body).toBe('{"workerId":"abc123"}');
    });

    it('should send JSON response with 201 status', () => {
      const res = createMockResponse();
      sendJson(res, 201, { created: true });

      expect(res.statusCode).toBe(201);
    });

    it('should send JSON response with 404 status', () => {
      const res = createMockResponse();
      sendJson(res, 404, { found: false });

      expect(res.statusCode).toBe(404);
    });

    it('should serialize complex objects', () => {
      const res = createMockResponse();
      const data = {
        job: {
          id: 'job-1',
          status: 'pending',
          metadata: {
            priority: 5,
            tags: ['urgent', 'api'],
          },
        },
      };
      sendJson(res, 200, data);

      expect(JSON.parse(res.body)).toEqual(data);
    });

    it('should serialize arrays', () => {
      const res = createMockResponse();
      sendJson(res, 200, [1, 2, 3]);

      expect(res.body).toBe('[1,2,3]');
    });

    it('should serialize null', () => {
      const res = createMockResponse();
      sendJson(res, 200, null);

      expect(res.body).toBe('null');
    });

    it('should serialize empty object', () => {
      const res = createMockResponse();
      sendJson(res, 200, {});

      expect(res.body).toBe('{}');
    });

    it('should call writeHead before end', () => {
      const res = createMockResponse();
      const writeHeadMock = res.writeHead as ReturnType<typeof vi.fn>;
      const endMock = res.end as ReturnType<typeof vi.fn>;

      sendJson(res, 200, { test: true });

      // Verify both were called
      expect(writeHeadMock).toHaveBeenCalledTimes(1);
      expect(endMock).toHaveBeenCalledTimes(1);

      // Verify order by checking invocation order
      const writeHeadOrder = writeHeadMock.mock.invocationCallOrder[0];
      const endOrder = endMock.mock.invocationCallOrder[0];
      expect(writeHeadOrder).toBeLessThan(endOrder);
    });
  });

  describe('sendError', () => {
    function createMockResponse(): ServerResponse & {
      headers: Record<string, string>;
      body: string;
      statusCode: number;
    } {
      const res = {
        headers: {} as Record<string, string>,
        body: '',
        statusCode: 0,
        writeHead: vi.fn((status: number, headers: Record<string, string>) => {
          res.statusCode = status;
          res.headers = headers;
          return res;
        }),
        end: vi.fn((data: string) => {
          res.body = data;
        }),
      };
      return res as unknown as ServerResponse & {
        headers: Record<string, string>;
        body: string;
        statusCode: number;
      };
    }

    it('should send error in orchestrator format', () => {
      const res = createMockResponse();
      sendError(res, 404, 'WORKER_NOT_FOUND', 'Worker with ID abc123 not found');

      expect(res.statusCode).toBe(404);
      expect(res.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(res.body)).toEqual({
        error: {
          code: 'WORKER_NOT_FOUND',
          message: 'Worker with ID abc123 not found',
        },
      });
    });

    it('should send 400 Bad Request error', () => {
      const res = createMockResponse();
      sendError(res, 400, 'INVALID_REQUEST', 'Missing required field: name');

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing required field: name',
        },
      });
    });

    it('should send 500 Internal Server Error', () => {
      const res = createMockResponse();
      sendError(res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        },
      });
    });

    it('should send 401 Unauthorized error', () => {
      const res = createMockResponse();
      sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        },
      });
    });

    it('should send 409 Conflict error', () => {
      const res = createMockResponse();
      sendError(res, 409, 'DUPLICATE_WORKER', 'Worker already registered');

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({
        error: {
          code: 'DUPLICATE_WORKER',
          message: 'Worker already registered',
        },
      });
    });

    it('should handle empty error message', () => {
      const res = createMockResponse();
      sendError(res, 400, 'EMPTY_MESSAGE', '');

      expect(JSON.parse(res.body)).toEqual({
        error: {
          code: 'EMPTY_MESSAGE',
          message: '',
        },
      });
    });

    it('should handle error message with special characters', () => {
      const res = createMockResponse();
      sendError(
        res,
        400,
        'SPECIAL_CHARS',
        'Error with "quotes" and \\ backslash'
      );

      const parsed = JSON.parse(res.body);
      expect(parsed.error.message).toBe('Error with "quotes" and \\ backslash');
    });
  });
});
