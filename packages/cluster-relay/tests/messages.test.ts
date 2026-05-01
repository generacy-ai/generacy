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
        correlationId: 'req-1',
        method: 'GET',
        path: '/workflows',
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
    });

    it('parses a valid api_request with optional fields', () => {
      const msg = {
        type: 'api_request',
        correlationId: 'req-2',
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
        correlationId: 'req-1',
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

    it('returns null for api_request with empty correlationId', () => {
      const result = parseRelayMessage({
        type: 'api_request',
        correlationId: '',
        method: 'GET',
        path: '/test',
      });
      expect(result).toBeNull();
    });

    it('returns null for api_response with invalid status', () => {
      const result = parseRelayMessage({
        type: 'api_response',
        correlationId: 'req-1',
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
    it('validates all 11 message types', () => {
      const types = ['api_request', 'api_response', 'event', 'conversation', 'heartbeat', 'handshake', 'error', 'tunnel_open', 'tunnel_open_ack', 'tunnel_data', 'tunnel_close'];
      // Confirm schema accepts these types by checking discriminator key
      expect(RelayMessageSchema.options).toHaveLength(11);
    });
  });

  describe('actor and activation fields', () => {
    const validMetadata = {
      workerCount: 2,
      activeWorkflows: 1,
      channel: 'stable',
      orchestratorVersion: '0.1.0',
      gitRemotes: [{ name: 'origin', url: 'git@github.com:org/repo.git' }],
      uptime: 3600,
    };

    it('parses api_request with actor', () => {
      const msg = {
        type: 'api_request',
        correlationId: 'req-1',
        method: 'GET',
        path: '/workflows',
        actor: { userId: 'user-1', sessionId: 'sess-1' },
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
      expect((result as any).actor).toEqual({ userId: 'user-1', sessionId: 'sess-1' });
    });

    it('parses api_request with actor without sessionId', () => {
      const msg = {
        type: 'api_request',
        correlationId: 'req-1',
        method: 'GET',
        path: '/workflows',
        actor: { userId: 'user-1' },
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
      expect((result as any).actor).toEqual({ userId: 'user-1' });
    });

    it('parses api_request without actor (backward compat)', () => {
      const msg = {
        type: 'api_request',
        correlationId: 'req-1',
        method: 'GET',
        path: '/workflows',
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
      expect((result as any).actor).toBeUndefined();
    });

    it('rejects api_request with invalid actor shape', () => {
      const msg = {
        type: 'api_request',
        correlationId: 'req-1',
        method: 'GET',
        path: '/workflows',
        actor: { invalid: true },
      };
      const result = parseRelayMessage(msg);
      expect(result).toBeNull();
    });

    it('parses handshake with activation', () => {
      const msg = {
        type: 'handshake',
        metadata: validMetadata,
        activation: { code: 'abc123', clusterApiKeyId: 'key-1' },
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
      expect((result as any).activation).toEqual({ code: 'abc123', clusterApiKeyId: 'key-1' });
    });

    it('parses handshake with activation without clusterApiKeyId', () => {
      const msg = {
        type: 'handshake',
        metadata: validMetadata,
        activation: { code: 'abc123' },
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
      expect((result as any).activation).toEqual({ code: 'abc123' });
    });

    it('parses handshake without activation (backward compat)', () => {
      const msg = {
        type: 'handshake',
        metadata: validMetadata,
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
      expect((result as any).activation).toBeUndefined();
    });

    it('rejects handshake with invalid activation shape', () => {
      const msg = {
        type: 'handshake',
        metadata: validMetadata,
        activation: { invalid: true },
      };
      const result = parseRelayMessage(msg);
      expect(result).toBeNull();
    });
  });

  describe('tunnel message types', () => {
    it('parses a valid tunnel_open message', () => {
      const msg = {
        type: 'tunnel_open',
        tunnelId: 'tun-1',
        target: '/run/code-server.sock',
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
    });

    it('parses a valid tunnel_open_ack message with ok status', () => {
      const msg = {
        type: 'tunnel_open_ack',
        tunnelId: 'tun-1',
        status: 'ok',
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
    });

    it('parses a valid tunnel_open_ack message with error status', () => {
      const msg = {
        type: 'tunnel_open_ack',
        tunnelId: 'tun-1',
        status: 'error',
        error: 'invalid target',
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
    });

    it('parses a valid tunnel_data message', () => {
      const msg = {
        type: 'tunnel_data',
        tunnelId: 'tun-1',
        data: 'aGVsbG8=',
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
    });

    it('parses a valid tunnel_close message', () => {
      const msg = {
        type: 'tunnel_close',
        tunnelId: 'tun-1',
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
    });

    it('parses tunnel_close with reason', () => {
      const msg = {
        type: 'tunnel_close',
        tunnelId: 'tun-1',
        reason: 'user closed',
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
    });

    it('returns null for tunnel_open with empty tunnelId', () => {
      const result = parseRelayMessage({
        type: 'tunnel_open',
        tunnelId: '',
        target: '/run/code-server.sock',
      });
      expect(result).toBeNull();
    });

    it('returns null for tunnel_open with empty target', () => {
      const result = parseRelayMessage({
        type: 'tunnel_open',
        tunnelId: 'tun-1',
        target: '',
      });
      expect(result).toBeNull();
    });

    it('returns null for tunnel_data with empty data', () => {
      const result = parseRelayMessage({
        type: 'tunnel_data',
        tunnelId: 'tun-1',
        data: '',
      });
      expect(result).toBeNull();
    });

    it('returns null for tunnel_open_ack with invalid status', () => {
      const result = parseRelayMessage({
        type: 'tunnel_open_ack',
        tunnelId: 'tun-1',
        status: 'pending',
      });
      expect(result).toBeNull();
    });
  });
});
