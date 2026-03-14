import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { RelayBridge } from '../relay-bridge.js';
import type { ClusterRelayClient, RelayMessage, RelayBridgeOptions } from '../../types/relay.js';
import type { SSESubscriptionManager } from '../../sse/subscriptions.js';
import type { FastifyInstance } from 'fastify';
import type { ConversationManager } from '../../conversation/conversation-manager.js';
import type { ConversationOutputEvent } from '../../conversation/types.js';

describe('RelayBridge conversation handling', () => {
  let bridge: RelayBridge;
  let mockClient: {
    connect: Mock;
    disconnect: Mock;
    send: Mock;
    on: Mock;
    off: Mock;
    isConnected: boolean;
  };
  let mockServer: { inject: Mock };
  let mockSseManager: { broadcast: Mock };
  let mockLogger: { info: Mock; warn: Mock; error: Mock };
  let mockConfig: RelayBridgeOptions['config'];
  let handlers: Record<string, ((...args: unknown[]) => void)[]>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = {};

    mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(),
      on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      }),
      off: vi.fn(),
      isConnected: true,
    };

    mockServer = { inject: vi.fn() };
    mockSseManager = { broadcast: vi.fn().mockReturnValue(0) };
    mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    mockConfig = {
      apiKey: 'test-key',
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

  // ---------------------------------------------------------------------------
  // Incoming conversation message routing
  // ---------------------------------------------------------------------------

  describe('incoming conversation messages', () => {
    it('should route conversation messages to ConversationManager.sendMessage()', async () => {
      const mockManager = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        setOutputCallback: vi.fn(),
      } as unknown as ConversationManager;

      bridge.setConversationManager(mockManager);
      await bridge.start();

      const messageHandler = handlers['message']?.[0];
      expect(messageHandler).toBeDefined();

      messageHandler!({
        type: 'conversation',
        conversationId: 'conv-1',
        data: { action: 'message', content: 'Hello, Claude!' },
      });

      // Allow async sendMessage to resolve
      await new Promise((r) => setTimeout(r, 10));

      expect(mockManager.sendMessage).toHaveBeenCalledWith('conv-1', 'Hello, Claude!');
    });

    it('should log warning when no ConversationManager is configured', async () => {
      await bridge.start();

      const messageHandler = handlers['message']?.[0];
      messageHandler!({
        type: 'conversation',
        conversationId: 'conv-1',
        data: { action: 'message', content: 'Hello!' },
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Received conversation message but no ConversationManager is configured',
      );
    });

    it('should log warning for invalid conversation relay input', async () => {
      const mockManager = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        setOutputCallback: vi.fn(),
      } as unknown as ConversationManager;

      bridge.setConversationManager(mockManager);
      await bridge.start();

      const messageHandler = handlers['message']?.[0];
      messageHandler!({
        type: 'conversation',
        conversationId: 'conv-1',
        data: { action: 'invalid_action', content: 'bad' },
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-1' }),
        'Invalid conversation relay input',
      );
      expect(mockManager.sendMessage).not.toHaveBeenCalled();
    });

    it('should log error when sendMessage fails', async () => {
      const mockManager = {
        sendMessage: vi.fn().mockRejectedValue(new Error('Conversation not found')),
        setOutputCallback: vi.fn(),
      } as unknown as ConversationManager;

      bridge.setConversationManager(mockManager);
      await bridge.start();

      const messageHandler = handlers['message']?.[0];
      messageHandler!({
        type: 'conversation',
        conversationId: 'conv-unknown',
        data: { action: 'message', content: 'Hello!' },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-unknown',
          err: 'Conversation not found',
        }),
        'Error routing conversation message to manager',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Output event forwarding
  // ---------------------------------------------------------------------------

  describe('output event forwarding', () => {
    it('should forward conversation output events through relay', async () => {
      let capturedCallback: ((conversationId: string, event: ConversationOutputEvent) => void) | null = null;

      const mockManager = {
        sendMessage: vi.fn(),
        setOutputCallback: vi.fn((cb: (id: string, event: ConversationOutputEvent) => void) => {
          capturedCallback = cb;
        }),
      } as unknown as ConversationManager;

      bridge.setConversationManager(mockManager);

      expect(capturedCallback).not.toBeNull();

      // Simulate a conversation output event
      capturedCallback!('conv-1', {
        event: 'output',
        payload: { text: 'Hello from Claude!' },
        timestamp: '2026-03-14T00:00:00.000Z',
      });

      expect(mockClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'conversation',
          conversationId: 'conv-1',
          data: {
            event: 'output',
            payload: { text: 'Hello from Claude!' },
            timestamp: '2026-03-14T00:00:00.000Z',
          },
        }),
      );
    });

    it('should forward tool_use events through relay', async () => {
      let capturedCallback: ((conversationId: string, event: ConversationOutputEvent) => void) | null = null;

      const mockManager = {
        sendMessage: vi.fn(),
        setOutputCallback: vi.fn((cb: (id: string, event: ConversationOutputEvent) => void) => {
          capturedCallback = cb;
        }),
      } as unknown as ConversationManager;

      bridge.setConversationManager(mockManager);

      capturedCallback!('conv-1', {
        event: 'tool_use',
        payload: { toolName: 'Read', callId: 'call-1', input: { path: '/test' } },
        timestamp: '2026-03-14T00:00:01.000Z',
      });

      expect(mockClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ event: 'tool_use' }),
        }),
      );
    });

    it('should not forward when relay is disconnected', async () => {
      mockClient.isConnected = false;

      let capturedCallback: ((conversationId: string, event: ConversationOutputEvent) => void) | null = null;

      const mockManager = {
        sendMessage: vi.fn(),
        setOutputCallback: vi.fn((cb: (id: string, event: ConversationOutputEvent) => void) => {
          capturedCallback = cb;
        }),
      } as unknown as ConversationManager;

      bridge.setConversationManager(mockManager);

      capturedCallback!('conv-1', {
        event: 'output',
        payload: { text: 'Hello!' },
        timestamp: '2026-03-14T00:00:00.000Z',
      });

      expect(mockClient.send).not.toHaveBeenCalled();
    });

    it('should handle send errors gracefully', async () => {
      mockClient.send.mockImplementation(() => {
        throw new Error('Send failed');
      });

      let capturedCallback: ((conversationId: string, event: ConversationOutputEvent) => void) | null = null;

      const mockManager = {
        sendMessage: vi.fn(),
        setOutputCallback: vi.fn((cb: (id: string, event: ConversationOutputEvent) => void) => {
          capturedCallback = cb;
        }),
      } as unknown as ConversationManager;

      bridge.setConversationManager(mockManager);

      // Should not throw
      capturedCallback!('conv-1', {
        event: 'error',
        payload: { message: 'Process crashed' },
        timestamp: '2026-03-14T00:00:00.000Z',
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-1',
          err: 'Send failed',
        }),
        'Error sending conversation output through relay',
      );
    });
  });
});
