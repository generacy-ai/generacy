import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  generateCorrelationId,
  getCorrelationId,
  correlationIdHook,
  correlationIdResponseHook,
  CORRELATION_ID_HEADER,
} from '../../../src/utils/correlation.js';

describe('correlation', () => {
  describe('generateCorrelationId', () => {
    it('should generate a valid UUID', () => {
      const id = generateCorrelationId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateCorrelationId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe('getCorrelationId', () => {
    it('should extract correlation ID from header', () => {
      const request = {
        headers: {
          [CORRELATION_ID_HEADER]: 'test-correlation-id-123',
        },
      } as unknown as FastifyRequest;

      const id = getCorrelationId(request);
      expect(id).toBe('test-correlation-id-123');
    });

    it('should generate new ID if header is missing', () => {
      const request = {
        headers: {},
      } as unknown as FastifyRequest;

      const id = getCorrelationId(request);
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('should generate new ID if header is empty', () => {
      const request = {
        headers: {
          [CORRELATION_ID_HEADER]: '',
        },
      } as unknown as FastifyRequest;

      const id = getCorrelationId(request);
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('should generate new ID if header is array', () => {
      const request = {
        headers: {
          [CORRELATION_ID_HEADER]: ['id1', 'id2'],
        },
      } as unknown as FastifyRequest;

      const id = getCorrelationId(request);
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });
  });

  describe('correlationIdHook', () => {
    let request: FastifyRequest;
    let reply: FastifyReply;

    beforeEach(() => {
      request = {
        headers: {},
      } as unknown as FastifyRequest;
      reply = {} as FastifyReply;
    });

    it('should set correlationId on request', async () => {
      await correlationIdHook(request, reply);
      expect(request.correlationId).toBeDefined();
      expect(request.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('should use existing header value', async () => {
      request.headers[CORRELATION_ID_HEADER] = 'existing-id';
      await correlationIdHook(request, reply);
      expect(request.correlationId).toBe('existing-id');
    });

    it('should return a promise', () => {
      const result = correlationIdHook(request, reply);
      expect(result).toBeInstanceOf(Promise);
    });
  });

  describe('correlationIdResponseHook', () => {
    let request: FastifyRequest;
    let reply: FastifyReply;
    let headerMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      headerMock = vi.fn();
      request = {
        correlationId: 'test-correlation-id',
      } as unknown as FastifyRequest;
      reply = {
        header: headerMock,
      } as unknown as FastifyReply;
    });

    it('should set correlation ID header on response', async () => {
      await correlationIdResponseHook(request, reply);
      expect(headerMock).toHaveBeenCalledWith(
        CORRELATION_ID_HEADER,
        'test-correlation-id'
      );
    });

    it('should return a promise', () => {
      const result = correlationIdResponseHook(request, reply);
      expect(result).toBeInstanceOf(Promise);
    });
  });
});
