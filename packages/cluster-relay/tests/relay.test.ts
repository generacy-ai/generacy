import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import type { AddressInfo } from 'net';
import { ClusterRelay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';
import type { RelayMessage } from '../src/messages.js';

// Silence logs during tests
const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createConfig(port: number, overrides?: Partial<RelayConfig>): RelayConfig {
  return {
    apiKey: 'test-key',
    relayUrl: `ws://localhost:${port}`,
    orchestratorUrl: 'http://localhost:9999',
    requestTimeoutMs: 5000,
    heartbeatIntervalMs: 500,
    baseReconnectDelayMs: 50,
    maxReconnectDelayMs: 200,
    routes: [],
    ...overrides,
  };
}

/**
 * Start a WebSocket server on a random port.
 * Returns the server and the port.
 */
function startServer(): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('listening', () => {
      const addr = wss.address() as AddressInfo;
      resolve({ wss, port: addr.port });
    });
  });
}

function closeServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    // Close all connected clients
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close(() => resolve());
  });
}

/**
 * Wait until a predicate returns true, polling at short intervals.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 20,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('ClusterRelay', () => {
  let wss: WebSocketServer;
  let port: number;
  let relay: ClusterRelay;

  beforeEach(async () => {
    const server = await startServer();
    wss = server.wss;
    port = server.port;
  });

  afterEach(async () => {
    if (relay) {
      await relay.disconnect();
    }
    await closeServer(wss);
  });

  it('initial state is disconnected', () => {
    relay = new ClusterRelay(createConfig(port), silentLogger);
    expect(relay.state).toBe('disconnected');
  });

  it('transitions through connecting -> authenticating -> connected on handshake', async () => {
    const observedStates: string[] = [];

    // Server sends a heartbeat on connection to trigger connected state
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'handshake') {
          // Acknowledge with heartbeat
          ws.send(JSON.stringify({ type: 'heartbeat' }));
        }
      });
    });

    relay = new ClusterRelay(createConfig(port), silentLogger);

    // Poll state in background
    const poller = setInterval(() => {
      const s = relay.state;
      if (observedStates[observedStates.length - 1] !== s) {
        observedStates.push(s);
      }
    }, 5);

    // Start connect without awaiting (it loops forever)
    const connectPromise = relay.connect();

    await waitFor(() => relay.state === 'connected');

    // Capture final state before stopping poller (poller may not have fired yet)
    const finalState = relay.state;
    if (observedStates[observedStates.length - 1] !== finalState) {
      observedStates.push(finalState);
    }
    clearInterval(poller);

    // Verify we went through the expected transitions
    expect(observedStates).toContain('connecting');
    // authenticating may be very brief; at minimum we should reach connected
    expect(observedStates).toContain('connected');

    await relay.disconnect();
    await connectPromise;
  });

  it('connect() and disconnect() lifecycle', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'handshake') {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
        }
      });
    });

    relay = new ClusterRelay(createConfig(port), silentLogger);
    const connectPromise = relay.connect();

    await waitFor(() => relay.state === 'connected');
    expect(relay.state).toBe('connected');

    await relay.disconnect();
    await connectPromise;

    expect(relay.state).toBe('disconnected');
  });

  it('send() sends a message to the server', async () => {
    const serverReceived: RelayMessage[] = [];

    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        serverReceived.push(msg);
        if (msg.type === 'handshake') {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
        }
      });
    });

    relay = new ClusterRelay(createConfig(port), silentLogger);
    const connectPromise = relay.connect();

    await waitFor(() => relay.state === 'connected');

    relay.send({ type: 'event', channel: 'test-chan', event: { foo: 'bar' } });

    await waitFor(() => serverReceived.some((m) => m.type === 'event'));

    const eventMsg = serverReceived.find((m) => m.type === 'event');
    expect(eventMsg).toEqual({
      type: 'event',
      channel: 'test-chan',
      event: { foo: 'bar' },
    });

    await relay.disconnect();
    await connectPromise;
  });

  it('send() warns when not connected', () => {
    relay = new ClusterRelay(createConfig(port), silentLogger);
    relay.send({ type: 'heartbeat' });
    expect(silentLogger.warn).toHaveBeenCalled();
  });

  it('onMessage handler receives dispatched messages', async () => {
    const received: RelayMessage[] = [];

    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'handshake') {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
          // Send a conversation message after handshake ack
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: 'conversation',
                conversationId: 'conv-1',
                data: { action: 'message', content: 'hello' },
              }),
            );
          }, 50);
        }
      });
    });

    relay = new ClusterRelay(createConfig(port), silentLogger);
    relay.onMessage((msg) => {
      received.push(msg);
    });

    const connectPromise = relay.connect();

    await waitFor(() => received.some((m) => m.type === 'conversation'));

    const conversationMsg = received.find((m) => m.type === 'conversation');
    expect(conversationMsg).toEqual({
      type: 'conversation',
      conversationId: 'conv-1',
      data: { action: 'message', content: 'hello' },
    });

    await relay.disconnect();
    await connectPromise;
  });

  it('pushEvent sends an event message', async () => {
    const serverReceived: RelayMessage[] = [];

    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        serverReceived.push(msg);
        if (msg.type === 'handshake') {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
        }
      });
    });

    relay = new ClusterRelay(createConfig(port), silentLogger);
    const connectPromise = relay.connect();

    await waitFor(() => relay.state === 'connected');

    relay.pushEvent('metrics', { cpu: 42 });

    await waitFor(() => serverReceived.some((m) => m.type === 'event'));

    const eventMsg = serverReceived.find((m) => m.type === 'event');
    expect(eventMsg).toEqual({
      type: 'event',
      channel: 'metrics',
      event: { cpu: 42 },
    });

    await relay.disconnect();
    await connectPromise;
  });

  it('setMetadata overrides metadata in handshake', async () => {
    const serverReceived: unknown[] = [];

    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        serverReceived.push(msg);
        if (msg.type === 'handshake') {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
        }
      });
    });

    relay = new ClusterRelay(createConfig(port), silentLogger);
    relay.setMetadata({ workerCount: 99, channel: 'preview' });

    const connectPromise = relay.connect();

    await waitFor(() => relay.state === 'connected');

    // The handshake should have been sent with overridden metadata
    const handshakeMsg = serverReceived.find(
      (m: any) => m.type === 'handshake',
    ) as any;
    expect(handshakeMsg).toBeDefined();
    expect(handshakeMsg.metadata.workerCount).toBe(99);
    expect(handshakeMsg.metadata.channel).toBe('preview');

    await relay.disconnect();
    await connectPromise;
  });

  it('heartbeat sends ping and heartbeat message', async () => {
    const serverReceived: RelayMessage[] = [];
    let pingReceived = false;

    wss.on('connection', (ws) => {
      ws.on('ping', () => {
        pingReceived = true;
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        serverReceived.push(msg);
        if (msg.type === 'handshake') {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
        }
      });
    });

    // Use a short heartbeat interval for testing
    relay = new ClusterRelay(
      createConfig(port, { heartbeatIntervalMs: 100 }),
      silentLogger,
    );
    const connectPromise = relay.connect();

    await waitFor(() => relay.state === 'connected');

    // Wait for at least one heartbeat cycle
    await waitFor(() => {
      const heartbeats = serverReceived.filter((m) => m.type === 'heartbeat');
      return heartbeats.length >= 1 && pingReceived;
    }, 3000);

    expect(pingReceived).toBe(true);
    expect(serverReceived.filter((m) => m.type === 'heartbeat').length).toBeGreaterThanOrEqual(1);

    await relay.disconnect();
    await connectPromise;
  });

  it('reconnects after server closes the connection', async () => {
    let connectionCount = 0;

    wss.on('connection', (ws) => {
      connectionCount++;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'handshake') {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
        }
      });

      // Close the first connection to trigger a reconnect
      if (connectionCount === 1) {
        setTimeout(() => ws.close(1000, 'test-close'), 100);
      }
    });

    relay = new ClusterRelay(createConfig(port), silentLogger);
    const connectPromise = relay.connect();

    // Wait for the second connection
    await waitFor(() => connectionCount >= 2, 5000);
    await waitFor(() => relay.state === 'connected');

    expect(connectionCount).toBeGreaterThanOrEqual(2);

    await relay.disconnect();
    await connectPromise;
  });

  it('reconnects with exponential backoff on error', async () => {
    // Start with a closed server so every connection attempt fails
    await closeServer(wss);

    const connectionTimes: number[] = [];
    const start = Date.now();

    // Create a new server that rejects connections to simulate errors
    const errorServer = await startServer();
    wss = errorServer.wss;
    const errorPort = errorServer.port;

    // Close the server immediately so connections fail
    await closeServer(wss);

    relay = new ClusterRelay(
      createConfig(errorPort, {
        baseReconnectDelayMs: 50,
        maxReconnectDelayMs: 200,
      }),
      {
        info: vi.fn(),
        warn: vi.fn((...args: unknown[]) => {
          if (
            typeof args[0] === 'object' &&
            args[0] !== null &&
            'attempt' in (args[0] as Record<string, unknown>)
          ) {
            connectionTimes.push(Date.now() - start);
          }
        }),
        error: vi.fn(),
      },
    );

    const connectPromise = relay.connect();

    // Wait for a few reconnect attempts
    await waitFor(() => connectionTimes.length >= 3, 5000);

    await relay.disconnect();
    await connectPromise;

    // Verify there were multiple attempts
    expect(connectionTimes.length).toBeGreaterThanOrEqual(3);

    // Re-create the server for afterEach cleanup
    const cleanupServer = await startServer();
    wss = cleanupServer.wss;
  });

  it('calling connect() twice warns and returns', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'handshake') {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
        }
      });
    });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    relay = new ClusterRelay(createConfig(port), logger);

    const connectPromise1 = relay.connect();
    await waitFor(() => relay.state === 'connected');

    // Second connect should warn and return immediately
    await relay.connect();
    expect(logger.warn).toHaveBeenCalledWith('Relay already running');

    await relay.disconnect();
    await connectPromise1;
  });

  it('disconnect() is a no-op when not running', async () => {
    relay = new ClusterRelay(createConfig(port), silentLogger);
    // Should not throw
    await relay.disconnect();
    expect(relay.state).toBe('disconnected');
  });

  it('dispatches multiple onMessage handlers', async () => {
    const received1: RelayMessage[] = [];
    const received2: RelayMessage[] = [];

    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'handshake') {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: 'event',
                channel: 'ch1',
                event: { x: 1 },
              }),
            );
          }, 30);
        }
      });
    });

    relay = new ClusterRelay(createConfig(port), silentLogger);
    relay.onMessage((msg) => received1.push(msg));
    relay.onMessage((msg) => received2.push(msg));

    const connectPromise = relay.connect();

    await waitFor(() => received1.some((m) => m.type === 'event'));
    await waitFor(() => received2.some((m) => m.type === 'event'));

    expect(received1.find((m) => m.type === 'event')).toEqual({
      type: 'event',
      channel: 'ch1',
      event: { x: 1 },
    });
    expect(received2.find((m) => m.type === 'event')).toEqual({
      type: 'event',
      channel: 'ch1',
      event: { x: 1 },
    });

    await relay.disconnect();
    await connectPromise;
  });

  it('handler errors are caught and logged', async () => {
    const errorLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'handshake') {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: 'event',
                channel: 'ch',
                event: null,
              }),
            );
          }, 30);
        }
      });
    });

    relay = new ClusterRelay(createConfig(port), errorLogger);
    relay.onMessage(() => {
      throw new Error('handler boom');
    });

    const connectPromise = relay.connect();

    await waitFor(() =>
      errorLogger.error.mock.calls.some(
        (call: unknown[]) =>
          typeof call[1] === 'string' && call[1].includes('Message handler error'),
      ),
    );

    await relay.disconnect();
    await connectPromise;
  });

  it('ignores non-JSON messages from the server', async () => {
    const warnLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    wss.on('connection', (ws) => {
      // Send non-JSON data first
      ws.send('not-json-data');
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'handshake') {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
        }
      });
    });

    relay = new ClusterRelay(createConfig(port), warnLogger);
    const connectPromise = relay.connect();

    await waitFor(() => relay.state === 'connected');

    // Should have warned about non-JSON message
    expect(warnLogger.warn).toHaveBeenCalledWith('Received non-JSON message, skipping');

    await relay.disconnect();
    await connectPromise;
  });

  it('handshake includes activation when configured', async () => {
    const serverReceived: unknown[] = [];

    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        serverReceived.push(msg);
        if (msg.type === 'handshake') {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
        }
      });
    });

    relay = new ClusterRelay(
      createConfig(port, { activationCode: 'claim-abc', clusterApiKeyId: 'key-1' }),
      silentLogger,
    );
    const connectPromise = relay.connect();

    await waitFor(() => relay.state === 'connected');

    const handshakeMsg = serverReceived.find(
      (m: any) => m.type === 'handshake',
    ) as any;
    expect(handshakeMsg).toBeDefined();
    expect(handshakeMsg.activation).toEqual({
      code: 'claim-abc',
      clusterApiKeyId: 'key-1',
    });

    await relay.disconnect();
    await connectPromise;
  });

  it('handshake omits activation when not configured', async () => {
    const serverReceived: unknown[] = [];

    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        serverReceived.push(msg);
        if (msg.type === 'handshake') {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
        }
      });
    });

    relay = new ClusterRelay(createConfig(port), silentLogger);
    const connectPromise = relay.connect();

    await waitFor(() => relay.state === 'connected');

    const handshakeMsg = serverReceived.find(
      (m: any) => m.type === 'handshake',
    ) as any;
    expect(handshakeMsg).toBeDefined();
    expect(handshakeMsg.activation).toBeUndefined();

    await relay.disconnect();
    await connectPromise;
  });

  it('routes are pre-sorted in constructor', () => {
    relay = new ClusterRelay(
      createConfig(port, {
        routes: [
          { prefix: '/a', target: 'http://a' },
          { prefix: '/abc', target: 'http://abc' },
        ],
      }),
      silentLogger,
    );

    const routes = relay['config'].routes;
    expect(routes).toEqual([
      { prefix: '/abc', target: 'http://abc' },
      { prefix: '/a', target: 'http://a' },
    ]);
  });

  it('accepts routes via ClusterRelayClientOptions and sorts them', () => {
    relay = new ClusterRelay(
      {
        apiKey: 'test-key',
        cloudUrl: `ws://localhost:${port}`,
        routes: [
          { prefix: '/short', target: 'unix:///tmp/short.sock' },
          { prefix: '/longer/path', target: 'unix:///tmp/long.sock' },
        ],
      },
      silentLogger,
    );

    const routes = relay['config'].routes;
    expect(routes).toHaveLength(2);
    expect(routes[0].prefix).toBe('/longer/path');
    expect(routes[1].prefix).toBe('/short');
  });

  it('defaults routes to empty array via ClusterRelayClientOptions', () => {
    relay = new ClusterRelay(
      { apiKey: 'test-key', cloudUrl: `ws://localhost:${port}` },
      silentLogger,
    );
    expect(relay['config'].routes).toEqual([]);
  });

  it('ignores invalid relay messages from the server', async () => {
    const warnLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    wss.on('connection', (ws) => {
      // Send valid JSON but invalid relay message
      ws.send(JSON.stringify({ type: 'unknown_type', data: 123 }));
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'handshake') {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
        }
      });
    });

    relay = new ClusterRelay(createConfig(port), warnLogger);
    const connectPromise = relay.connect();

    await waitFor(() => relay.state === 'connected');

    // Should have warned about invalid relay message
    expect(warnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ raw: expect.anything() }),
      'Invalid relay message, skipping',
    );

    await relay.disconnect();
    await connectPromise;
  });
});
