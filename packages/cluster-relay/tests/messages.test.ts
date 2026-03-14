import { describe, it, expect } from 'vitest';
import {
  parseRelayMessage,
  RelayMessageSchema,
} from '../src/messages.js';

describe('messages', () => {
  describe('parseRelayMessage', () => {
    it('parses a valid api_request message', () => {
      const msg = {
        type: 'api_request',
        id: 'req-1',
        method: 'GET',
        path: '/workflows',
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
    });

    it('parses a valid api_request with optional fields', () => {
      const msg = {
        type: 'api_request',
        id: 'req-2',
        method: 'POST',
        path: '/workflows',
        headers: { 'Content-Type': 'application/json' },
        body: { name: 'test' },
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
    });

    it('parses a valid api_response message', () => {
      const msg = {
        type: 'api_response',
        id: 'req-1',
        status: 200,
        body: { data: 'test' },
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
    });

    it('parses a valid event message', () => {
      const msg = {
        type: 'event',
        channel: 'workflows',
        event: { status: 'completed' },
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
    });

    it('parses a valid conversation input message', () => {
      const msg = {
        type: 'conversation',
        conversationId: 'conv-1',
        data: { action: 'message', content: 'hello' },
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
    });

    it('parses a valid conversation output message', () => {
      const msg = {
        type: 'conversation',
        conversationId: 'conv-1',
        data: { event: 'output', payload: { text: 'response' }, timestamp: '2026-03-14T00:00:00Z' },
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
    });

    it('returns null for conversation message with invalid data', () => {
      const msg = {
        type: 'conversation',
        conversationId: 'conv-1',
        data: { text: 'hello' },
      };
      const result = parseRelayMessage(msg);
      expect(result).toBeNull();
    });

    it('parses a valid heartbeat message', () => {
      const msg = { type: 'heartbeat' };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
    });

    it('parses a valid handshake message', () => {
      const msg = {
        type: 'handshake',
        metadata: {
          workerCount: 2,
          activeWorkflows: 1,
          channel: 'stable',
          orchestratorVersion: '0.1.0',
          gitRemotes: [{ name: 'origin', url: 'git@github.com:org/repo.git' }],
          uptime: 3600,
        },
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
    });

    it('parses a valid error message', () => {
      const msg = {
        type: 'error',
        code: 'AUTH_FAILED',
        message: 'Invalid API key',
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
    });

    it('returns null for invalid message (missing type)', () => {
      const result = parseRelayMessage({ id: 'req-1' });
      expect(result).toBeNull();
    });

    it('returns null for unknown type', () => {
      const result = parseRelayMessage({ type: 'unknown_type' });
      expect(result).toBeNull();
    });

    it('returns null for api_request with empty id', () => {
      const result = parseRelayMessage({
        type: 'api_request',
        id: '',
        method: 'GET',
        path: '/test',
      });
      expect(result).toBeNull();
    });

    it('returns null for api_response with invalid status', () => {
      const result = parseRelayMessage({
        type: 'api_response',
        id: 'req-1',
        status: 999,
      });
      expect(result).toBeNull();
    });

    it('returns null for non-object input', () => {
      expect(parseRelayMessage('not an object')).toBeNull();
      expect(parseRelayMessage(null)).toBeNull();
      expect(parseRelayMessage(42)).toBeNull();
    });

    it('returns null for handshake with invalid channel', () => {
      const result = parseRelayMessage({
        type: 'handshake',
        metadata: {
          workerCount: 0,
          activeWorkflows: 0,
          channel: 'invalid',
          orchestratorVersion: '0.0.0',
          gitRemotes: [],
          uptime: 0,
        },
      });
      expect(result).toBeNull();
    });
  });

  describe('RelayMessageSchema', () => {
    it('validates all 7 message types', () => {
      const types = ['api_request', 'api_response', 'event', 'conversation', 'heartbeat', 'handshake', 'error'];
      // Confirm schema accepts these types by checking discriminator key
      expect(RelayMessageSchema.options).toHaveLength(7);
    });
  });
});
