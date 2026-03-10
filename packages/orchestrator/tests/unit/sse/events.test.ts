import { describe, it, expect } from 'vitest';
import {
  generateEventId,
  createEventIdGenerator,
  formatSSEEvent,
  formatHeartbeat,
  createWorkflowEvent,
  createQueueEvent,
  createAgentEvent,
  createErrorEvent,
  createConnectedEvent,
  createSSEEvent,
} from '../../../src/sse/events.js';
import type { SSEEvent } from '../../../src/types/sse.js';

describe('SSE Events', () => {
  describe('generateEventId', () => {
    it('should generate event ID with timestamp, connection ID, and sequence', () => {
      const connectionId = 'conn_abc123';
      const sequence = 42;

      const id = generateEventId(connectionId, sequence);

      expect(id).toMatch(/^\d+_conn_abc123_42$/);
    });

    it('should generate unique IDs for different calls', () => {
      const id1 = generateEventId('conn_1', 1);
      const id2 = generateEventId('conn_2', 1);

      expect(id1).not.toBe(id2);
    });
  });

  describe('createEventIdGenerator', () => {
    it('should create a generator that produces sequential IDs', () => {
      const generator = createEventIdGenerator('conn_test');

      const id1 = generator();
      const id2 = generator();
      const id3 = generator();

      expect(id1).toContain('_conn_test_1');
      expect(id2).toContain('_conn_test_2');
      expect(id3).toContain('_conn_test_3');
    });
  });

  describe('formatSSEEvent', () => {
    it('should format event with event, id, and data fields', () => {
      const event: SSEEvent<{ message: string }> = {
        event: 'workflow:started',
        id: '1234567890_conn_abc_1',
        data: { message: 'test' },
        timestamp: '2024-01-24T10:00:00Z',
      };

      const formatted = formatSSEEvent(event);

      expect(formatted).toContain('event: workflow:started');
      expect(formatted).toContain('id: 1234567890_conn_abc_1');
      expect(formatted).toContain('data: {"message":"test"}');
      expect(formatted.endsWith('\n\n')).toBe(true);
    });

    it('should handle complex data payloads', () => {
      const event: SSEEvent<object> = {
        event: 'workflow:completed',
        id: '1234567890_conn_abc_2',
        data: {
          workflowId: 'wf_123',
          status: 'completed',
          nested: { key: 'value' },
        },
        timestamp: '2024-01-24T10:00:00Z',
      };

      const formatted = formatSSEEvent(event);

      expect(formatted).toContain('event: workflow:completed');
      expect(formatted).toContain('"workflowId":"wf_123"');
      expect(formatted).toContain('"nested":{"key":"value"}');
    });
  });

  describe('formatHeartbeat', () => {
    it('should format heartbeat as SSE comment', () => {
      const heartbeat = formatHeartbeat();

      expect(heartbeat).toMatch(/^: heartbeat \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(heartbeat.endsWith('\n\n')).toBe(true);
    });
  });

  describe('createWorkflowEvent', () => {
    it('should create workflow event with correct structure', () => {
      const event = createWorkflowEvent(
        'workflow:started',
        {
          workflowId: 'wf_123',
          status: 'running',
        },
        'conn_abc',
        1
      );

      expect(event.event).toBe('workflow:started');
      expect(event.data.workflowId).toBe('wf_123');
      expect(event.data.status).toBe('running');
      expect(event.id).toContain('conn_abc_1');
      expect(event.timestamp).toBeDefined();
    });
  });

  describe('createQueueEvent', () => {
    it('should create queue added event', () => {
      const item = {
        id: 'dec_1',
        workflowId: 'wf_123',
        stepId: 'step_1',
        type: 'approval' as const,
        prompt: 'Approve?',
        context: {},
        priority: 'blocking_now' as const,
        createdAt: '2024-01-24T10:00:00Z',
      };

      const event = createQueueEvent('added', [item], 5, 'conn_abc', 1);

      expect(event.event).toBe('queue:item:added');
      expect(event.data.action).toBe('added');
      expect(event.data.item).toEqual(item);
      expect(event.data.queueSize).toBe(5);
    });

    it('should create queue removed event', () => {
      const event = createQueueEvent('removed', [], 4, 'conn_abc', 2);

      expect(event.event).toBe('queue:item:removed');
      expect(event.data.action).toBe('removed');
    });

    it('should create queue updated event', () => {
      const event = createQueueEvent('updated', [], 6, 'conn_abc', 3);

      expect(event.event).toBe('queue:updated');
      expect(event.data.action).toBe('updated');
    });
  });

  describe('createAgentEvent', () => {
    it('should create agent connected event', () => {
      const agent = {
        id: 'agent_1',
        name: 'Claude Agent',
        type: 'claude' as const,
        status: 'connected' as const,
        capabilities: ['code-review', 'implementation'],
        lastSeen: '2024-01-24T10:00:00Z',
        metadata: {},
      };

      const event = createAgentEvent('connected', agent, 'conn_abc', 1);

      expect(event.event).toBe('agent:connected');
      expect(event.data.agentId).toBe('agent_1');
      expect(event.data.status).toBe('connected');
      expect(event.data.capabilities).toEqual(['code-review', 'implementation']);
    });

    it('should create agent disconnected event', () => {
      const agent = {
        id: 'agent_1',
        name: 'Claude Agent',
        type: 'claude' as const,
        status: 'disconnected' as const,
        capabilities: [],
        lastSeen: '2024-01-24T10:00:00Z',
        metadata: {},
      };

      const event = createAgentEvent('disconnected', agent, 'conn_abc', 2);

      expect(event.event).toBe('agent:disconnected');
    });
  });

  describe('createErrorEvent', () => {
    it('should create error event with correct structure', () => {
      const event = createErrorEvent(
        'Unauthorized',
        'Invalid token',
        401,
        'conn_abc',
        1,
        'trace_123'
      );

      expect(event.event).toBe('error');
      expect(event.data.title).toBe('Unauthorized');
      expect(event.data.detail).toBe('Invalid token');
      expect(event.data.status).toBe(401);
      expect(event.data.traceId).toBe('trace_123');
    });
  });

  describe('createConnectedEvent', () => {
    it('should create connected confirmation event', () => {
      const event = createConnectedEvent('conn_abc', ['workflows', 'queue'], 1);

      expect(event.event).toBe('connected');
      expect(event.data.connectionId).toBe('conn_abc');
      expect(event.data.channels).toEqual(['workflows', 'queue']);
      expect(event.data.timestamp).toBeDefined();
    });
  });

  describe('createSSEEvent', () => {
    it('should create generic SSE event', () => {
      const event = createSSEEvent(
        'workflow:completed',
        { result: 'success' },
        'conn_abc',
        1
      );

      expect(event.event).toBe('workflow:completed');
      expect(event.data).toEqual({ result: 'success' });
      expect(event.id).toContain('conn_abc_1');
    });
  });
});
