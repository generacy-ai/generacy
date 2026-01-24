import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ServerResponse, IncomingMessage } from 'http';
import { SSEStream, parseLastEventId } from '../../../src/sse/stream.js';
import { parseEventId } from '../../../src/types/sse.js';

// Mock ServerResponse
function createMockResponse(): ServerResponse & { writtenData: string[] } {
  const emitter = new EventEmitter();
  const response = Object.assign(emitter, {
    writtenData: [] as string[],
    writableEnded: false,
    setHeader: vi.fn(),
    write: vi.fn((data: string) => {
      response.writtenData.push(data);
      return true;
    }),
    end: vi.fn(() => {
      response.writableEnded = true;
    }),
  });
  return response as unknown as ServerResponse & { writtenData: string[] };
}

// Mock IncomingMessage
function createMockRequest(headers: Record<string, string> = {}): IncomingMessage {
  const request = new EventEmitter() as IncomingMessage;
  (request as unknown as { headers: Record<string, string> }).headers = headers;
  return request;
}

// Mock FastifyRequest
function createMockFastifyRequest(
  headers: Record<string, string> = {}
): FastifyRequest {
  const raw = createMockRequest(headers);
  return {
    raw,
    headers,
  } as unknown as FastifyRequest;
}

describe('SSEStream', () => {
  let mockResponse: ServerResponse & { writtenData: string[] };
  let mockRequest: FastifyRequest;

  beforeEach(() => {
    vi.useFakeTimers();
    mockResponse = createMockResponse();
    mockRequest = createMockFastifyRequest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create stream with unique connection ID', () => {
      const stream = new SSEStream(mockResponse, mockRequest, 'user_123');

      expect(stream.id).toMatch(/^conn_[a-f0-9]{8}$/);
    });

    it('should set user ID', () => {
      const stream = new SSEStream(mockResponse, mockRequest, 'user_123');

      expect(stream.userId).toBe('user_123');
    });

    it('should use default channels if none provided', () => {
      const stream = new SSEStream(mockResponse, mockRequest, 'user_123');

      expect(stream.channels).toEqual(['workflows', 'queue', 'agents']);
    });

    it('should use provided channels', () => {
      const stream = new SSEStream(mockResponse, mockRequest, 'user_123', {
        channels: ['workflows'],
      });

      expect(stream.channels).toEqual(['workflows']);
    });

    it('should set filters', () => {
      const stream = new SSEStream(mockResponse, mockRequest, 'user_123', {
        filters: { workflowId: 'wf_123' },
      });

      expect(stream.filters.workflowId).toBe('wf_123');
    });
  });

  describe('start', () => {
    it('should set SSE headers', () => {
      const stream = new SSEStream(mockResponse, mockRequest, 'user_123');

      stream.start();

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'text/event-stream'
      );
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'no-cache, no-transform'
      );
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    });

    it('should send connected event', () => {
      const stream = new SSEStream(mockResponse, mockRequest, 'user_123', {
        channels: ['workflows'],
      });

      stream.start();

      const sentData = mockResponse.writtenData.join('');
      expect(sentData).toContain('event: connected');
      expect(sentData).toContain('"channels":["workflows"]');
    });

    it('should start heartbeat timer', () => {
      const stream = new SSEStream(
        mockResponse,
        mockRequest,
        'user_123',
        {},
        { heartbeatInterval: 5000, maxConnectionsPerClient: 3, eventBufferSize: 100, eventRetentionMs: 60000 }
      );

      stream.start();

      // Initial write count
      const initialWrites = mockResponse.writtenData.length;

      // Advance past heartbeat interval
      vi.advanceTimersByTime(5000);

      expect(mockResponse.writtenData.length).toBeGreaterThan(initialWrites);
      expect(mockResponse.writtenData[mockResponse.writtenData.length - 1]).toContain(
        ': heartbeat'
      );

      stream.close();
    });
  });

  describe('send', () => {
    it('should send formatted SSE event', () => {
      const stream = new SSEStream(mockResponse, mockRequest, 'user_123');
      stream.start();

      const initialWrites = mockResponse.writtenData.length;

      const sent = stream.send({
        event: 'workflow:started',
        id: 'test_id_1',
        data: { workflowId: 'wf_123' },
        timestamp: '2024-01-24T10:00:00Z',
      });

      expect(sent).toBe(true);
      expect(mockResponse.writtenData.length).toBeGreaterThan(initialWrites);

      const lastWrite = mockResponse.writtenData[mockResponse.writtenData.length - 1];
      expect(lastWrite).toContain('event: workflow:started');
      expect(lastWrite).toContain('id: test_id_1');
      expect(lastWrite).toContain('"workflowId":"wf_123"');

      stream.close();
    });

    it('should return false when stream is closed', () => {
      const stream = new SSEStream(mockResponse, mockRequest, 'user_123');
      stream.start();
      stream.close();

      const sent = stream.send({
        event: 'workflow:started',
        id: 'test_id_1',
        data: {},
        timestamp: '2024-01-24T10:00:00Z',
      });

      expect(sent).toBe(false);
    });
  });

  describe('sendHeartbeat', () => {
    it('should send heartbeat comment', () => {
      const stream = new SSEStream(mockResponse, mockRequest, 'user_123');
      stream.start();

      const initialWrites = mockResponse.writtenData.length;

      const sent = stream.sendHeartbeat();

      expect(sent).toBe(true);
      expect(mockResponse.writtenData.length).toBeGreaterThan(initialWrites);
      expect(mockResponse.writtenData[mockResponse.writtenData.length - 1]).toContain(
        ': heartbeat'
      );

      stream.close();
    });
  });

  describe('isSubscribedTo', () => {
    it('should return true for subscribed channels', () => {
      const stream = new SSEStream(mockResponse, mockRequest, 'user_123', {
        channels: ['workflows', 'queue'],
      });

      expect(stream.isSubscribedTo('workflows')).toBe(true);
      expect(stream.isSubscribedTo('queue')).toBe(true);
      expect(stream.isSubscribedTo('agents')).toBe(false);
    });
  });

  describe('matchesFilters', () => {
    it('should match when no filters set', () => {
      const stream = new SSEStream(mockResponse, mockRequest, 'user_123');

      expect(stream.matchesFilters('any_workflow')).toBe(true);
    });

    it('should match workflow ID filter', () => {
      const stream = new SSEStream(mockResponse, mockRequest, 'user_123', {
        filters: { workflowId: 'wf_123' },
      });

      expect(stream.matchesFilters('wf_123')).toBe(true);
      expect(stream.matchesFilters('wf_456')).toBe(false);
    });

    it('should match tags filter', () => {
      const stream = new SSEStream(mockResponse, mockRequest, 'user_123', {
        filters: { tags: ['important', 'urgent'] },
      });

      expect(stream.matchesFilters(undefined, ['important'])).toBe(true);
      expect(stream.matchesFilters(undefined, ['other'])).toBe(false);
      expect(stream.matchesFilters(undefined, ['important', 'other'])).toBe(true);
    });
  });

  describe('close', () => {
    it('should mark stream as closed', () => {
      const stream = new SSEStream(mockResponse, mockRequest, 'user_123');
      stream.start();

      expect(stream.isClosed).toBe(false);

      stream.close();

      expect(stream.isClosed).toBe(true);
    });

    it('should stop heartbeat timer', () => {
      const stream = new SSEStream(
        mockResponse,
        mockRequest,
        'user_123',
        {},
        { heartbeatInterval: 5000, maxConnectionsPerClient: 3, eventBufferSize: 100, eventRetentionMs: 60000 }
      );
      stream.start();
      stream.close();

      const writesAfterClose = mockResponse.writtenData.length;

      // Advance past heartbeat interval
      vi.advanceTimersByTime(10000);

      // No new writes should occur
      expect(mockResponse.writtenData.length).toBe(writesAfterClose);
    });

    it('should end response stream', () => {
      const stream = new SSEStream(mockResponse, mockRequest, 'user_123');
      stream.start();
      stream.close();

      expect(mockResponse.end).toHaveBeenCalled();
    });
  });

  describe('getInfo', () => {
    it('should return connection info', () => {
      const stream = new SSEStream(mockResponse, mockRequest, 'user_123', {
        channels: ['workflows'],
        filters: { workflowId: 'wf_123' },
      });

      const info = stream.getInfo();

      expect(info.id).toBe(stream.id);
      expect(info.userId).toBe('user_123');
      expect(info.channels).toEqual(['workflows']);
      expect(info.filters.workflowId).toBe('wf_123');
      expect(info.connectedAt).toBeInstanceOf(Date);
    });
  });
});

describe('parseLastEventId', () => {
  it('should parse Last-Event-ID header', () => {
    const request = createMockFastifyRequest({
      'last-event-id': '1706097600000_conn_abc_42',
    });

    const result = parseLastEventId(request);

    expect(result).toEqual({
      timestamp: 1706097600000,
      connectionId: 'conn_abc',
      sequence: 42,
    });
  });

  it('should return null when header is missing', () => {
    const request = createMockFastifyRequest();

    const result = parseLastEventId(request);

    expect(result).toBeNull();
  });

  it('should return null for invalid format', () => {
    const request = createMockFastifyRequest({
      'last-event-id': 'invalid',
    });

    const result = parseLastEventId(request);

    expect(result).toBeNull();
  });
});

describe('parseEventId', () => {
  it('should parse valid event ID', () => {
    const result = parseEventId('1706097600000_conn_abc_42');

    expect(result).toEqual({
      timestamp: 1706097600000,
      connectionId: 'conn_abc',
      sequence: 42,
    });
  });

  it('should handle connection IDs with underscores', () => {
    const result = parseEventId('1706097600000_conn_abc_def_42');

    expect(result).toEqual({
      timestamp: 1706097600000,
      connectionId: 'conn_abc_def',
      sequence: 42,
    });
  });

  it('should return null for invalid format', () => {
    expect(parseEventId('invalid')).toBeNull();
    expect(parseEventId('abc_def')).toBeNull();
    expect(parseEventId('123_456')).toBeNull();
  });
});
