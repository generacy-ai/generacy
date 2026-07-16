/**
 * Integration test for the #966 retained-tunnel-event replay path.
 *
 * Boots a Fastify server with the /internal/relay-events route and a stubbed
 * ClusterRelayClient. Verifies the end-to-end write→retain→reconnect→replay
 * cycle for cluster.vscode-tunnel events.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { RelayBridge } from '../services/relay-bridge.js';
import { setupInternalRelayEventsRoute } from '../routes/internal-relay-events.js';
import {
  clearRetainedTunnelEvent,
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

describe('vscode-tunnel retained-event integration', () => {
  let server: FastifyInstance;
  let client: FakeRelayClient;
  let bridge: RelayBridge;

  beforeEach(async () => {
    clearRetainedTunnelEvent();

    client = new FakeRelayClient();
    server = Fastify();
    setupInternalRelayEventsRoute(server, () => client);
    await server.ready();

    bridge = new RelayBridge({
      client,
      server: { inject: vi.fn() } as unknown as FastifyInstance,
      sseManager: {
        broadcast: vi.fn().mockReturnValue(0),
      } as unknown as SSESubscriptionManager,
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

    await bridge.start();
  });

  afterEach(async () => {
    await bridge.stop();
    await server.close();
    clearRetainedTunnelEvent();
  });

  it('retains authorization_pending while disconnected, replays exactly once on reconnect', async () => {
    // (a) Post an authorization_pending event while stub is disconnected.
    client.isConnected = false;
    const timestamp = '2026-07-01T12:00:00.000Z';
    const dataPayload = {
      status: 'authorization_pending',
      deviceCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      tunnelName: 'g-test',
    };

    const response = await server.inject({
      method: 'POST',
      url: '/internal/relay-events',
      payload: {
        event: 'cluster.vscode-tunnel',
        data: dataPayload,
        timestamp,
      },
    });

    expect(response.statusCode).toBe(204);
    const retained = getRetainedTunnelEvent();
    expect(retained).not.toBeNull();
    expect(retained?.event).toBe('cluster.vscode-tunnel');
    expect(retained?.status).toBe('authorization_pending');
    expect(retained?.timestamp).toBe(timestamp);
    expect(retained?.data).toEqual(dataPayload);

    // No client.send calls yet (disconnected).
    const preReconnectEvents = client.sent.filter(
      (m) => m.type === 'event' && m.event === 'cluster.vscode-tunnel',
    );
    expect(preReconnectEvents).toHaveLength(0);

    // (b) Flip stub → connected and invoke the reconnect handler.
    client.isConnected = true;
    client.fire('connected');

    // (c) Assert exactly one send on the replay.
    const tunnelSends = client.sent.filter(
      (m) => m.type === 'event' && m.event === 'cluster.vscode-tunnel',
    );
    expect(tunnelSends).toHaveLength(1);
    expect(tunnelSends[0]).toMatchObject({
      type: 'event',
      event: 'cluster.vscode-tunnel',
      timestamp,
      data: dataPayload,
    });

    // (d) Slot cleared after successful replay.
    expect(getRetainedTunnelEvent()).toBeNull();
  });
});
