import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { RelayBridge } from '../relay-bridge.js';
import type { ClusterRelayClient, RelayMessage, RelayBridgeOptions } from '../../types/relay.js';
import type { SSESubscriptionManager } from '../../sse/subscriptions.js';
import type { FastifyInstance } from 'fastify';

describe('RelayBridge', () => {
  let bridge: RelayBridge;
  let mockClient: {
    connect: Mock;
    disconnect: Mock;
    send: Mock;
    on: Mock;
    off: Mock;
    isConnected: boolean;
  };
  let mockServer: {
    inject: Mock;
  };
  let mockSseManager: {
    broadcast: Mock;
  };
  let mockLogger: {
    info: Mock;
    warn: Mock;
    error: Mock;
  };
  let mockConfig: RelayBridgeOptions['config'];

  // Capture registered event handlers from mock client
  let handlers: Record<string, ((...args: unknown[]) => void)[]>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    handlers = {};

    mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(),
      on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      }),
      off: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        if (handlers[event]) {
          handlers[event] = handlers[event].filter(h => h !== handler);
        }
      }),
      isConnected: false,
    };

    mockServer = {
      inject: vi.fn(),
    };

    mockSseManager = {
      broadcast: vi.fn().mockReturnValue(0),
    };

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    mockConfig = {
      apiKey: 'test-api-key',
      cloudUrl: 'wss://test.relay.com',
      metadataIntervalMs: 60000,
      clusterYamlPath: '.generacy/cluster.yaml',
    };

    bridge = new RelayBridge({
      client: mockClient as unknown as ClusterRelayClient,
      server: mockServer as unknown as FastifyInstance,
      sseManager: mockSseManager as unknown as SSESubscriptionManager,
      logger: mockLogger,
      config: mockConfig,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Start/Stop Lifecycle
  // ---------------------------------------------------------------------------

  describe('start/stop lifecycle', () => {
    it('should connect the relay client on start', async () => {
      await bridge.start();

      expect(mockClient.connect).toHaveBeenCalledOnce();
    });

    it('should register event handlers before connecting', async () => {
      await bridge.start();

      expect(mockClient.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('connected', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('disconnected', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('error', expect.any(Function));

      // Handlers registered before connect
      const onCallOrder = mockClient.on.mock.invocationCallOrder;
      const connectCallOrder = mockClient.connect.mock.invocationCallOrder;
      expect(Math.max(...onCallOrder)).toBeLessThan(Math.min(...connectCallOrder));
    });

    it('should not start twice', async () => {
      await bridge.start();
      await bridge.start();

      expect(mockClient.connect).toHaveBeenCalledOnce();
      expect(mockLogger.warn).toHaveBeenCalledWith('Relay bridge already running');
    });

    it('should disconnect the relay client on stop', async () => {
      await bridge.start();
      await bridge.stop();

      expect(mockClient.disconnect).toHaveBeenCalledOnce();
    });

    it('should remove event handlers on stop', async () => {
      await bridge.start();
      await bridge.stop();

      expect(mockClient.off).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockClient.off).toHaveBeenCalledWith('connected', expect.any(Function));
      expect(mockClient.off).toHaveBeenCalledWith('disconnected', expect.any(Function));
      expect(mockClient.off).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should handle connection failure gracefully (local-only mode)', async () => {
      mockClient.connect.mockRejectedValueOnce(new Error('Connection refused'));

      await bridge.start(); // Should NOT throw

      expect(mockLogger.error).toHaveBeenCalledWith(
        { err: 'Connection refused' },
        'Relay connection failed, continuing in local-only mode',
      );
    });

    it('should handle disconnect error gracefully', async () => {
      mockClient.disconnect.mockRejectedValueOnce(new Error('Disconnect failed'));

      await bridge.start();
      await bridge.stop(); // Should NOT throw

      expect(mockLogger.error).toHaveBeenCalledWith(
        { err: 'Disconnect failed' },
        'Error during relay disconnect',
      );
    });

    it('should not disconnect if not running', async () => {
      await bridge.stop();

      expect(mockClient.disconnect).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // API Request Routing
  // ---------------------------------------------------------------------------

  describe('API request routing', () => {
    it('should route api_request through server.inject() and send api_response', async () => {
      await bridge.start();

      mockServer.inject.mockResolvedValueOnce({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"workflows":[]}',
      });

      mockClient.isConnected = true;

      // Trigger message handler
      const messageHandler = handlers['message']?.[0];
      expect(messageHandler).toBeDefined();

      const apiRequest: RelayMessage = {
        type: 'api_request',
        id: 'req-123',
        method: 'GET',
        url: '/workflows',
      };

      messageHandler!(apiRequest);

      // Wait for async inject to resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(mockServer.inject).toHaveBeenCalledWith({
        method: 'GET',
        url: '/workflows',
        headers: undefined,
        payload: undefined,
      });

      expect(mockClient.send).toHaveBeenCalledWith({
        type: 'api_response',
        id: 'req-123',
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: { workflows: [] },
      });
    });

    it('should forward request headers and body', async () => {
      await bridge.start();

      mockServer.inject.mockResolvedValueOnce({
        statusCode: 201,
        headers: { 'content-type': 'application/json' },
        body: '{"id":"wf-1"}',
      });

      mockClient.isConnected = true;

      const messageHandler = handlers['message']?.[0];
      const apiRequest: RelayMessage = {
        type: 'api_request',
        id: 'req-456',
        method: 'POST',
        url: '/workflows',
        headers: { 'content-type': 'application/json' },
        body: { name: 'test-workflow' },
      };

      messageHandler!(apiRequest);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockServer.inject).toHaveBeenCalledWith({
        method: 'POST',
        url: '/workflows',
        headers: { 'content-type': 'application/json' },
        payload: { name: 'test-workflow' },
      });
    });

    it('should send 500 response when inject() fails', async () => {
      await bridge.start();

      mockServer.inject.mockRejectedValueOnce(new Error('Route not found'));
      mockClient.isConnected = true;

      const messageHandler = handlers['message']?.[0];
      messageHandler!({
        type: 'api_request',
        id: 'req-err',
        method: 'GET',
        url: '/nonexistent',
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(mockClient.send).toHaveBeenCalledWith({
        type: 'api_response',
        id: 'req-err',
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        body: { error: 'Internal relay routing error' },
      });
    });

    it('should not crash when send fails on error response', async () => {
      await bridge.start();

      mockServer.inject.mockRejectedValueOnce(new Error('Route not found'));
      mockClient.send.mockImplementationOnce(() => {
        throw new Error('Send failed');
      });

      const messageHandler = handlers['message']?.[0];
      messageHandler!({
        type: 'api_request',
        id: 'req-crash',
        method: 'GET',
        url: '/fail',
      });

      await vi.advanceTimersByTimeAsync(0);

      // Should not throw — error is caught internally
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Event Forwarding
  // ---------------------------------------------------------------------------

  describe('event forwarding', () => {
    it('should decorate sseManager.broadcast to forward events on connect', async () => {
      await bridge.start();
      mockClient.isConnected = true;

      // Trigger connected handler
      const connectedHandler = handlers['connected']?.[0];
      connectedHandler!();

      // The original broadcast should be saved and a new one installed
      const originalBroadcast = mockSseManager.broadcast;

      // Call the decorated broadcast
      mockSseManager.broadcast('workflows', {
        event: 'workflow:started',
        id: 'evt-1',
        data: { workflowId: 'wf-1' },
        timestamp: new Date().toISOString(),
      });

      // Should forward via relay
      expect(mockClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'event',
          channel: 'workflows',
          event: expect.objectContaining({ event: 'workflow:started' }),
        }),
      );
    });

    it('should restore original broadcast on disconnect', async () => {
      await bridge.start();
      mockClient.isConnected = true;

      // Connect then disconnect
      const connectedHandler = handlers['connected']?.[0];
      connectedHandler!();

      const disconnectedHandler = handlers['disconnected']?.[0];
      disconnectedHandler!('test disconnect');

      // After disconnect, calling broadcast should NOT forward via relay
      mockClient.send.mockClear();
      mockSseManager.broadcast('workflows', {
        event: 'workflow:started',
        id: 'evt-restored',
        data: { workflowId: 'wf-restored' },
        timestamp: new Date().toISOString(),
      });

      // No relay event sends
      const eventSends = mockClient.send.mock.calls.filter(
        (call: unknown[]) => (call[0] as RelayMessage).type === 'event',
      );
      expect(eventSends).toHaveLength(0);
    });

    it('should restore original broadcast on stop', async () => {
      await bridge.start();
      mockClient.isConnected = true;

      const connectedHandler = handlers['connected']?.[0];
      connectedHandler!();

      await bridge.stop();

      // After stop, calling broadcast should NOT forward via relay
      mockClient.send.mockClear();
      mockSseManager.broadcast('workflows', {
        event: 'workflow:started',
        id: 'evt-stopped',
        data: { workflowId: 'wf-stopped' },
        timestamp: new Date().toISOString(),
      });

      const eventSends = mockClient.send.mock.calls.filter(
        (call: unknown[]) => (call[0] as RelayMessage).type === 'event',
      );
      expect(eventSends).toHaveLength(0);
    });

    it('should not forward events when relay is disconnected', async () => {
      await bridge.start();
      mockClient.isConnected = false;

      const connectedHandler = handlers['connected']?.[0];
      connectedHandler!();

      // Call broadcast — relay is disconnected
      mockSseManager.broadcast('workflows', {
        event: 'workflow:started',
        id: 'evt-2',
        data: { workflowId: 'wf-2' },
        timestamp: new Date().toISOString(),
      });

      // send() should not have been called (client.send calls from metadata only)
      // Filter out metadata sends
      const eventSends = mockClient.send.mock.calls.filter(
        (call: unknown[]) => (call[0] as RelayMessage).type === 'event',
      );
      expect(eventSends).toHaveLength(0);
    });

    it('should not crash when event forwarding fails', async () => {
      await bridge.start();
      mockClient.isConnected = true;

      const connectedHandler = handlers['connected']?.[0];
      connectedHandler!();

      // Make send throw
      mockClient.send.mockImplementation((msg: RelayMessage) => {
        if (msg.type === 'event') throw new Error('Send failed');
      });

      // Should not throw
      mockSseManager.broadcast('workflows', {
        event: 'workflow:started',
        id: 'evt-3',
        data: { workflowId: 'wf-3' },
        timestamp: new Date().toISOString(),
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        { err: 'Send failed' },
        'Error forwarding event through relay',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  describe('metadata', () => {
    it('should send metadata on connect', async () => {
      await bridge.start();
      mockClient.isConnected = true;

      const connectedHandler = handlers['connected']?.[0];
      connectedHandler!();

      const metadataSends = mockClient.send.mock.calls.filter(
        (call: unknown[]) => (call[0] as RelayMessage).type === 'metadata',
      );
      expect(metadataSends).toHaveLength(1);

      const metadata = metadataSends[0][0] as { type: string; data: Record<string, unknown> };
      expect(metadata.data).toHaveProperty('version');
      expect(metadata.data).toHaveProperty('uptimeSeconds');
      expect(metadata.data).toHaveProperty('activeWorkflowCount');
      expect(metadata.data).toHaveProperty('gitRemotes');
      expect(metadata.data).toHaveProperty('reportedAt');
    });

    it('should send metadata periodically', async () => {
      await bridge.start();
      mockClient.isConnected = true;

      const connectedHandler = handlers['connected']?.[0];
      connectedHandler!();

      // Clear the initial send
      mockClient.send.mockClear();

      // Advance timer by metadata interval
      await vi.advanceTimersByTimeAsync(60000);

      const metadataSends = mockClient.send.mock.calls.filter(
        (call: unknown[]) => (call[0] as RelayMessage).type === 'metadata',
      );
      expect(metadataSends).toHaveLength(1);
    });

    it('should clear metadata timer on disconnect', async () => {
      await bridge.start();
      mockClient.isConnected = true;

      const connectedHandler = handlers['connected']?.[0];
      connectedHandler!();

      mockClient.send.mockClear();

      const disconnectedHandler = handlers['disconnected']?.[0];
      disconnectedHandler!('test');

      // Advance timer — should NOT send metadata
      await vi.advanceTimersByTimeAsync(60000);

      const metadataSends = mockClient.send.mock.calls.filter(
        (call: unknown[]) => (call[0] as RelayMessage).type === 'metadata',
      );
      expect(metadataSends).toHaveLength(0);
    });

    it('should clear metadata timer on stop', async () => {
      await bridge.start();
      mockClient.isConnected = true;

      const connectedHandler = handlers['connected']?.[0];
      connectedHandler!();

      mockClient.send.mockClear();

      await bridge.stop();

      await vi.advanceTimersByTimeAsync(60000);

      expect(mockClient.send).not.toHaveBeenCalled();
    });

    it('should handle metadata collection errors gracefully', async () => {
      // collectMetadata is called internally — errors should be caught
      await bridge.start();
      mockClient.isConnected = true;
      mockClient.send.mockImplementation((msg: RelayMessage) => {
        if (msg.type === 'metadata') throw new Error('Send failed');
      });

      const connectedHandler = handlers['connected']?.[0];
      connectedHandler!(); // Should not throw

      expect(mockLogger.error).toHaveBeenCalledWith(
        { err: 'Send failed' },
        'Error sending metadata',
      );
    });

    it('should not send metadata when client is disconnected', async () => {
      await bridge.start();
      mockClient.isConnected = false;

      const connectedHandler = handlers['connected']?.[0];
      connectedHandler!();

      const metadataSends = mockClient.send.mock.calls.filter(
        (call: unknown[]) => (call[0] as RelayMessage).type === 'metadata',
      );
      expect(metadataSends).toHaveLength(0);
    });

    it('should collect metadata with expected fields', () => {
      const metadata = bridge.collectMetadata();

      expect(metadata.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(metadata.activeWorkflowCount).toBe(0);
      expect(Array.isArray(metadata.gitRemotes)).toBe(true);
      expect(metadata.reportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof metadata.version).toBe('string');
    });
  });

  // ---------------------------------------------------------------------------
  // Error Handling
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('should log relay client errors', async () => {
      await bridge.start();

      const errorHandler = handlers['error']?.[0];
      errorHandler!(new Error('WebSocket error'));

      expect(mockLogger.error).toHaveBeenCalledWith(
        { err: 'WebSocket error' },
        'Relay client error',
      );
    });

    it('should log disconnect reasons', async () => {
      await bridge.start();

      const disconnectedHandler = handlers['disconnected']?.[0];
      disconnectedHandler!('server closed');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { reason: 'server closed' },
        'Relay disconnected from cloud',
      );
    });

    it('should ignore non-api_request messages', async () => {
      await bridge.start();

      const messageHandler = handlers['message']?.[0];
      messageHandler!({ type: 'api_response', id: 'resp-1', statusCode: 200, headers: {}, body: null });

      expect(mockServer.inject).not.toHaveBeenCalled();
    });
  });
});
