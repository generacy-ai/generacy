import { describe, it, expect } from 'vitest';
import {
  parseRelayMessage,
  RelayMessageSchema,
  EventMessageSchema,
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
        event: 'cluster.audit',
        data: { status: 'completed' },
        timestamp: '2026-05-12T18:00:00.000Z',
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
          workers: 2,
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
          workers: 0,
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
    it('validates all 18 message types', () => {
      const types = [
        'api_request', 'api_response', 'event', 'conversation', 'heartbeat', 'handshake', 'error',
        'lease_request', 'lease_release', 'lease_heartbeat', 'lease_response', 'slot_available',
        'cluster_rejected', 'tier_info',
        'tunnel_open', 'tunnel_open_ack', 'tunnel_data', 'tunnel_close',
      ];
      expect(types).toHaveLength(18);
      // Confirm schema accepts these types by checking discriminator key
      expect(RelayMessageSchema.options).toHaveLength(18);
    });
  });

  describe('EventMessage round-trip', () => {
    it('round-trips through JSON serialization and schema parse', () => {
      const original = {
        type: 'event' as const,
        event: 'cluster.vscode-tunnel',
        data: { status: 'connected', tunnelId: 'tun-1' },
        timestamp: '2026-05-12T18:00:00.000Z',
      };
      const json = JSON.stringify(original);
      const parsed = JSON.parse(json);
      const result = EventMessageSchema.safeParse(parsed);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(original);
      }
    });

    it('rejects event message with empty event name', () => {
      const result = EventMessageSchema.safeParse({
        type: 'event',
        event: '',
        data: {},
        timestamp: '2026-05-12T18:00:00.000Z',
      });
      expect(result.success).toBe(false);
    });

    it('rejects event message with invalid timestamp', () => {
      const result = EventMessageSchema.safeParse({
        type: 'event',
        event: 'cluster.audit',
        data: {},
        timestamp: 'not-a-timestamp',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('actor and activation fields', () => {
    const validMetadata = {
      workers: 2,
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

  describe('lease protocol message types (#1016)', () => {
    it('parses a valid lease_request message', () => {
      const msg = {
        type: 'lease_request',
        correlationId: 'corr-1',
        queueItemId: 'owner/repo#42',
        jobId: 'owner/repo#42',
        userId: 'user-1',
      };
      const result = parseRelayMessage(msg);
      expect(result).toEqual(msg);
    });

    it('parses a lease_request without optional userId', () => {
      const msg = {
        type: 'lease_request',
        correlationId: 'corr-1',
        queueItemId: 'owner/repo#42',
        jobId: 'owner/repo#42',
      };
      expect(parseRelayMessage(msg)).toEqual(msg);
    });

    it('parses a valid lease_release message', () => {
      const msg = {
        type: 'lease_release',
        correlationId: 'corr-2',
        leaseId: 'lease-1',
      };
      expect(parseRelayMessage(msg)).toEqual(msg);
    });

    it('rejects a lease_release without correlationId (cloud requires it)', () => {
      const msg = { type: 'lease_release', leaseId: 'lease-1' };
      expect(parseRelayMessage(msg)).toBeNull();
    });

    it('parses a valid lease_heartbeat message', () => {
      const msg = { type: 'lease_heartbeat', leaseId: 'lease-1' };
      expect(parseRelayMessage(msg)).toEqual(msg);
    });

    it('parses a granted lease_response with full payload', () => {
      const msg = {
        type: 'lease_response',
        correlationId: 'corr-1',
        status: 'granted',
        leaseId: 'lease-1',
        ttlSeconds: 300,
      };
      expect(parseRelayMessage(msg)).toEqual(msg);
    });

    it('parses a denied lease_response with limit context', () => {
      const msg = {
        type: 'lease_response',
        correlationId: 'corr-1',
        status: 'denied',
        reason: 'at_capacity',
        currentCount: 1,
        limit: 1,
      };
      expect(parseRelayMessage(msg)).toEqual(msg);
    });

    it('parses released and error lease_response statuses', () => {
      expect(
        parseRelayMessage({ type: 'lease_response', correlationId: 'c', status: 'released' }),
      ).not.toBeNull();
      expect(
        parseRelayMessage({ type: 'lease_response', correlationId: 'c', status: 'error', message: 'boom' }),
      ).not.toBeNull();
    });

    it('rejects a lease_response with an unknown status', () => {
      const msg = { type: 'lease_response', correlationId: 'c', status: 'maybe' };
      expect(parseRelayMessage(msg)).toBeNull();
    });

    it('parses a slot_available broadcast (org-broadcast shape)', () => {
      const msg = {
        type: 'slot_available',
        userId: 'user-1',
        orgId: 'org-1',
        timestamp: '2026-07-21T00:00:00.000Z',
      };
      expect(parseRelayMessage(msg)).toEqual(msg);
    });

    it('parses a minimal slot_available with only userId', () => {
      const msg = { type: 'slot_available', userId: 'user-1' };
      expect(parseRelayMessage(msg)).toEqual(msg);
    });

    it('parses a cluster_rejected message with cloud field names', () => {
      const msg = {
        type: 'cluster_rejected',
        reason: 'cluster_limit_reached',
        currentLimit: 1,
        tierName: 'free',
        upgradeHint: 'Upgrade to run more clusters.',
      };
      expect(parseRelayMessage(msg)).toEqual(msg);
    });

    it('parses a tier_info message', () => {
      const msg = {
        type: 'tier_info',
        tier: 'professional',
        maxConcurrentWorkflows: 5,
      };
      expect(parseRelayMessage(msg)).toEqual(msg);
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
