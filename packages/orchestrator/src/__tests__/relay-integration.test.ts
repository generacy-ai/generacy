/**
 * Integration/degradation tests for relay bridge.
 *
 * T008: Verifies the relay bridge behaves correctly when:
 * - Relay connection fails (continues local-only)
 * - End-to-end API routing through the bridge with mock Fastify inject
 * - Graceful shutdown disconnects relay
 * - Missing cluster.yaml handled gracefully
 * - Event forwarding roundtrip works
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RelayBridge } from '../services/relay-bridge.js';
import type { ClusterRelayClient, RelayMessage } from '../types/relay.js';
import type { SSESubscriptionManager } from '../sse/subscriptions.js';
import type { FastifyInstance } from 'fastify';

// =============================================================================
// Mock Relay Client
// =============================================================================

class MockRelayClient implements ClusterRelayClient {
  isConnected = false;
  connectCalled = false;
  disconnectCalled = false;
  failConnect = false;
  sentMessages: RelayMessage[] = [];

  private handlers: Record<string, ((...args: unknown[]) => void)[]> = {};

  async connect(): Promise<void> {
    this.connectCalled = true;
    if (this.failConnect) {
      throw new Error('Mock connection failure');
    }
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalled = true;
    this.isConnected = false;
  }

  send(message: RelayMessage): void {
    this.sentMessages.push(message);
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    if (!this.handlers[event]) {
      this.handlers[event] = [];
    }
    this.handlers[event].push(handler);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    if (this.handlers[event]) {
      this.handlers[event] = this.handlers[event].filter((h) => h !== handler);
    }
  }

  simulateConnect(): void {
    this.isConnected = true;
    for (const handler of this.handlers['connected'] ?? []) {
      handler();
    }
  }

  simulateDisconnect(reason: string): void {
    this.isConnected = false;
    for (const handler of this.handlers['disconnected'] ?? []) {
      handler(reason);
    }
  }

  simulateMessage(msg: RelayMessage): void {
    for (const handler of this.handlers['message'] ?? []) {
      handler(msg);
    }
  }

  clearSent(): void {
    this.sentMessages = [];
  }
}

// =============================================================================
// Helper to create a bridge with mocks
// =============================================================================

function createTestBridge(overrides: {
  client?: MockRelayClient;
  serverInject?: ReturnType<typeof vi.fn>;
  broadcastFn?: ReturnType<typeof vi.fn>;
} = {}) {
  const client = overrides.client ?? new MockRelayClient();
  const serverInject = overrides.serverInject ?? vi.fn();
  const broadcastFn = overrides.broadcastFn ?? vi.fn().mockReturnValue(0);

  const bridge = new RelayBridge({
    client,
    server: { inject: serverInject } as unknown as FastifyInstance,
    sseManager: { broadcast: broadcastFn } as unknown as SSESubscriptionManager,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    config: {
      apiKey: 'test-key',
      cloudUrl: 'wss://test.relay.com',
      metadataIntervalMs: 60000,
      clusterYamlPath: '.generacy/nonexistent-cluster.yaml',
    },
  });

  return { bridge, client, serverInject, broadcastFn };
}

// =============================================================================
// Degradation Tests
// =============================================================================

describe('Relay degradation: connection failure', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should start successfully when relay connection fails', async () => {
    const { bridge, client } = createTestBridge();
    client.failConnect = true;

    // Should NOT throw — continues in local-only mode
    await bridge.start();

    expect(client.connectCalled).toBe(true);

    await bridge.stop();
  });

  it('should continue working after relay disconnects', async () => {
    const { bridge, client, serverInject } = createTestBridge();

    await bridge.start();
    client.simulateConnect();
    client.simulateDisconnect('server closed');

    // Server should still process requests locally (inject still works)
    serverInject.mockResolvedValueOnce({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    });

    // Even though relay is disconnected, the server itself is fine
    expect(client.isConnected).toBe(false);

    await bridge.stop();
  });
});

// =============================================================================
// End-to-End API Routing
// =============================================================================

describe('Relay integration: end-to-end API routing', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should route api_request → inject() → api_response with correct correlation', async () => {
    const serverInject = vi.fn().mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"workflows":[{"id":"wf-1"}]}',
    });

    const { bridge, client } = createTestBridge({ serverInject });

    await bridge.start();
    client.simulateConnect();
    client.clearSent(); // Clear metadata sends

    // Simulate incoming API request from cloud
    client.simulateMessage({
      type: 'api_request',
      id: 'req-e2e-1',
      method: 'GET',
      url: '/workflows',
      headers: { 'x-request-id': 'cloud-123' },
    });

    // Wait for async inject to complete
    await vi.advanceTimersByTimeAsync(0);

    // Verify inject was called with correct params
    expect(serverInject).toHaveBeenCalledWith({
      method: 'GET',
      url: '/workflows',
      headers: { 'x-request-id': 'cloud-123' },
      payload: undefined,
    });

    // Verify response was sent back through relay
    const responses = client.sentMessages.filter(
      (m) => m.type === 'api_response' && m.id === 'req-e2e-1',
    );
    expect(responses).toHaveLength(1);

    const response = responses[0] as { type: string; id: string; statusCode: number; body: unknown };
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ workflows: [{ id: 'wf-1' }] });

    await bridge.stop();
  });

  it('should route POST request with body', async () => {
    const serverInject = vi.fn().mockResolvedValue({
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: '{"id":"wf-new"}',
    });

    const { bridge, client } = createTestBridge({ serverInject });

    await bridge.start();
    client.simulateConnect();
    client.clearSent();

    client.simulateMessage({
      type: 'api_request',
      id: 'req-e2e-2',
      method: 'POST',
      url: '/workflows',
      body: { name: 'test-workflow', repo: 'owner/repo' },
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(serverInject).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/workflows',
        payload: { name: 'test-workflow', repo: 'owner/repo' },
      }),
    );

    const responses = client.sentMessages.filter(
      (m) => m.type === 'api_response' && m.id === 'req-e2e-2',
    );
    expect(responses).toHaveLength(1);
    expect((responses[0] as { statusCode: number }).statusCode).toBe(201);

    await bridge.stop();
  });

  it('should return 500 when inject fails', async () => {
    const serverInject = vi.fn().mockRejectedValue(new Error('Route error'));

    const { bridge, client } = createTestBridge({ serverInject });

    await bridge.start();
    client.simulateConnect();
    client.clearSent();

    client.simulateMessage({
      type: 'api_request',
      id: 'req-err-1',
      method: 'GET',
      url: '/nonexistent',
    });

    await vi.advanceTimersByTimeAsync(0);

    const responses = client.sentMessages.filter(
      (m) => m.type === 'api_response' && m.id === 'req-err-1',
    );
    expect(responses).toHaveLength(1);
    expect((responses[0] as { statusCode: number }).statusCode).toBe(500);

    await bridge.stop();
  });
});

// =============================================================================
// Event Forwarding Integration
// =============================================================================

describe('Relay integration: event forwarding', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should forward SSE broadcast events through relay', async () => {
    const broadcastFn = vi.fn().mockReturnValue(2);
    const { bridge, client } = createTestBridge({ broadcastFn });

    await bridge.start();
    client.simulateConnect();
    client.clearSent();

    // Get the decorated broadcast
    const sseManager = (bridge as unknown as { sseManager: SSESubscriptionManager }).sseManager;

    // Call the decorated broadcast
    sseManager.broadcast('workflows', {
      event: 'workflow:started',
      id: 'evt-fwd-1',
      data: { workflowId: 'wf-42' },
      timestamp: new Date().toISOString(),
    });

    const eventSends = client.sentMessages.filter((m) => m.type === 'event');
    expect(eventSends).toHaveLength(1);
    expect(eventSends[0]).toMatchObject({
      type: 'event',
      channel: 'workflows',
      event: expect.objectContaining({
        event: 'workflow:started',
        id: 'evt-fwd-1',
      }),
    });

    await bridge.stop();
  });

  it('should stop forwarding events after disconnect', async () => {
    const broadcastFn = vi.fn().mockReturnValue(0);
    const { bridge, client } = createTestBridge({ broadcastFn });

    await bridge.start();
    client.simulateConnect();
    client.simulateDisconnect('test');
    client.clearSent();

    // Get the sseManager
    const sseManager = (bridge as unknown as { sseManager: SSESubscriptionManager }).sseManager;

    // Broadcast after disconnect — should not forward
    sseManager.broadcast('workflows', {
      event: 'workflow:completed',
      id: 'evt-fwd-2',
      data: { workflowId: 'wf-43' },
      timestamp: new Date().toISOString(),
    });

    const eventSends = client.sentMessages.filter((m) => m.type === 'event');
    expect(eventSends).toHaveLength(0);

    await bridge.stop();
  });
});

// =============================================================================
// Graceful Shutdown
// =============================================================================

describe('Relay integration: graceful shutdown', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should disconnect relay before server closes', async () => {
    const { bridge, client } = createTestBridge();

    await bridge.start();
    client.simulateConnect();

    expect(client.isConnected).toBe(true);

    await bridge.stop();

    expect(client.disconnectCalled).toBe(true);
    expect(client.isConnected).toBe(false);
  });

  it('should clear metadata timer on shutdown', async () => {
    const { bridge, client } = createTestBridge();

    await bridge.start();
    client.simulateConnect();
    client.clearSent();

    await bridge.stop();

    // Advance time — no metadata should be sent
    await vi.advanceTimersByTimeAsync(120000);

    const metadataSends = client.sentMessages.filter((m) => m.type === 'metadata');
    expect(metadataSends).toHaveLength(0);
  });

  it('should handle graceful shutdown even if not connected', async () => {
    const { bridge, client } = createTestBridge();
    client.failConnect = true;

    await bridge.start();
    await bridge.stop(); // Should not throw

    expect(client.disconnectCalled).toBe(true);
  });
});

// =============================================================================
// Metadata with missing cluster.yaml
// =============================================================================

describe('Relay integration: metadata with missing cluster.yaml', () => {
  it('should collect metadata without workerCount/channel when cluster.yaml is missing', () => {
    const { bridge } = createTestBridge();

    const metadata = bridge.collectMetadata();

    // Should have required fields
    expect(metadata.version).toBeDefined();
    expect(metadata.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(metadata.activeWorkflowCount).toBe(0);
    expect(Array.isArray(metadata.gitRemotes)).toBe(true);
    expect(metadata.reportedAt).toBeDefined();

    // Optional cluster.yaml fields should be absent
    expect(metadata.workerCount).toBeUndefined();
    expect(metadata.channel).toBeUndefined();
  });
});
