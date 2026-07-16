import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RelayBridge } from '../services/relay-bridge.js';
import {
  clearRetainedTunnelEvent,
  setRetainedTunnelEvent,
  getRetainedTunnelEvent,
} from '../routes/retained-tunnel-event.js';
import type { ClusterRelayClient, RelayMessage } from '../types/relay.js';
import type { SSESubscriptionManager } from '../sse/subscriptions.js';

class FakeRelayClient implements ClusterRelayClient {
  isConnected = false;
  sent: RelayMessage[] = [];
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  async connect(): Promise<void> {
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
  }

  send(message: RelayMessage): void {
    this.sent.push(message);
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    (this.handlers[event] ??= []).push(handler);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers[event];
    if (!list) return;
    this.handlers[event] = list.filter((h) => h !== handler);
  }

  fire(event: string, ...args: unknown[]): void {
    for (const h of this.handlers[event] ?? []) {
      h(...args);
    }
  }
}

function createTestBridge(client: FakeRelayClient): RelayBridge {
  const serverInject = vi.fn();
  const broadcastFn = vi.fn().mockReturnValue(0);
  return new RelayBridge({
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
      metadataIntervalMs: 60_000,
      clusterYamlPath: '.generacy/nonexistent-cluster.yaml',
    },
  });
}

describe('RelayBridge — retained cluster.vscode-tunnel replay', () => {
  beforeEach(() => {
    clearRetainedTunnelEvent();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    clearRetainedTunnelEvent();
  });

  it('empty slot → no send, slot stays empty', async () => {
    const client = new FakeRelayClient();
    const bridge = createTestBridge(client);
    await bridge.start();
    client.isConnected = true;
    client.fire('connected');

    const eventSends = client.sent.filter((m) => m.type === 'event');
    expect(eventSends).toHaveLength(0);
    expect(getRetainedTunnelEvent()).toBeNull();

    await bridge.stop();
  });

  it('populated slot + connected → sends exactly one event and clears', async () => {
    const timestamp = '2026-07-01T12:00:00.000Z';
    setRetainedTunnelEvent({
      event: 'cluster.vscode-tunnel',
      data: {
        status: 'authorization_pending',
        deviceCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        tunnelName: 'g-test',
      },
      timestamp,
      status: 'authorization_pending',
    });

    const client = new FakeRelayClient();
    const bridge = createTestBridge(client);
    await bridge.start();
    client.isConnected = true;
    client.fire('connected');

    const tunnelSends = client.sent.filter(
      (m) => m.type === 'event' && m.event === 'cluster.vscode-tunnel',
    );
    expect(tunnelSends).toHaveLength(1);
    const first = tunnelSends[0];
    expect(first).toMatchObject({
      type: 'event',
      event: 'cluster.vscode-tunnel',
      timestamp,
      data: {
        status: 'authorization_pending',
        deviceCode: 'ABCD-1234',
      },
    });
    expect(getRetainedTunnelEvent()).toBeNull();

    await bridge.stop();
  });

  it('populated slot + isConnected=false at replay time → no send, slot retained', async () => {
    const timestamp = '2026-07-01T12:00:00.000Z';
    const retainedEvent = {
      event: 'cluster.vscode-tunnel' as const,
      data: { status: 'authorization_pending', deviceCode: 'WXYZ-9876' },
      timestamp,
      status: 'authorization_pending' as const,
    };
    setRetainedTunnelEvent(retainedEvent);

    const client = new FakeRelayClient();
    const bridge = createTestBridge(client);
    await bridge.start();
    client.isConnected = false;
    client.fire('connected');

    const tunnelSends = client.sent.filter(
      (m) => m.type === 'event' && m.event === 'cluster.vscode-tunnel',
    );
    expect(tunnelSends).toHaveLength(0);
    expect(getRetainedTunnelEvent()).not.toBeNull();
    expect(getRetainedTunnelEvent()?.timestamp).toBe(timestamp);

    await bridge.stop();
  });
});
