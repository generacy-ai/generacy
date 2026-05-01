import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { TunnelHandler } from '../../src/services/tunnel-handler.js';
import type { RelayMessageSender } from '../../src/services/tunnel-handler.js';
import type { CodeServerManager } from '../../src/services/code-server-manager.js';

// ---------------------------------------------------------------------------
// Mock socket helper
// ---------------------------------------------------------------------------
class MockSocket extends EventEmitter {
  write = vi.fn();
  destroy = vi.fn(() => {
    this.emit('close');
  });
}

function createMockSocket(): MockSocket {
  return new MockSocket();
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------
function createMockRelaySender(): RelayMessageSender {
  return { send: vi.fn() };
}

function createMockCodeServerManager(): CodeServerManager {
  return {
    start: vi.fn().mockResolvedValue({ status: 'running', socket_path: '/run/code-server.sock' }),
    stop: vi.fn().mockResolvedValue(undefined),
    touch: vi.fn(),
    getStatus: vi.fn().mockReturnValue('running'),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('TunnelHandler', () => {
  let relaySend: RelayMessageSender;
  let codeServerManager: CodeServerManager;
  let handler: TunnelHandler;
  let createConnectionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    relaySend = createMockRelaySender();
    codeServerManager = createMockCodeServerManager();
    handler = new TunnelHandler(relaySend, codeServerManager);

    // Default: createConnection returns a mock socket that connects on nextTick
    createConnectionSpy = vi.spyOn(net, 'createConnection').mockImplementation((_opts: any, cb?: () => void) => {
      const socket = createMockSocket();
      if (cb) {
        process.nextTick(cb);
      }
      return socket as unknown as net.Socket;
    });
  });

  afterEach(() => {
    handler.cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // handleOpen
  // -------------------------------------------------------------------------
  describe('handleOpen', () => {
    it('rejects invalid target path', async () => {
      await handler.handleOpen({ tunnelId: 't1', target: '/tmp/evil.sock' });

      expect(relaySend.send).toHaveBeenCalledWith({
        type: 'tunnel_open_ack',
        tunnelId: 't1',
        status: 'error',
        error: 'invalid target',
      });

      // Should not have attempted to start code-server
      expect(codeServerManager.start).not.toHaveBeenCalled();
    });

    it('sends ok ack on successful connect', async () => {
      await handler.handleOpen({ tunnelId: 't1', target: '/run/code-server.sock' });

      expect(codeServerManager.start).toHaveBeenCalled();
      expect(relaySend.send).toHaveBeenCalledWith({
        type: 'tunnel_open_ack',
        tunnelId: 't1',
        status: 'ok',
      });
    });

    it('sends error ack on connection timeout', async () => {
      vi.useFakeTimers();

      // Return a socket that never emits 'connect' (callback never called)
      createConnectionSpy.mockImplementation((_opts: any, _cb?: () => void) => {
        const socket = createMockSocket();
        // Wire up error listener removal to prevent unhandled errors during destroy
        socket.destroy = vi.fn(() => {
          // do not emit close to avoid side-effects
        });
        return socket as unknown as net.Socket;
      });

      const openPromise = handler.handleOpen({ tunnelId: 't1', target: '/run/code-server.sock' });

      // Advance past the 10s timeout
      await vi.advanceTimersByTimeAsync(10_001);
      await openPromise;

      expect(relaySend.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tunnel_open_ack',
          tunnelId: 't1',
          status: 'error',
          error: expect.stringContaining('Timeout'),
        }),
      );
    });

    it('sends error ack when code-server start fails', async () => {
      (codeServerManager.start as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('code-server binary not found'),
      );

      await handler.handleOpen({ tunnelId: 't1', target: '/run/code-server.sock' });

      expect(relaySend.send).toHaveBeenCalledWith({
        type: 'tunnel_open_ack',
        tunnelId: 't1',
        status: 'error',
        error: 'code-server binary not found',
      });
    });

    it('sends error ack when socket emits error before connecting', async () => {
      createConnectionSpy.mockImplementation((_opts: any, _cb?: () => void) => {
        const socket = createMockSocket();
        process.nextTick(() => {
          socket.emit('error', new Error('ECONNREFUSED'));
        });
        return socket as unknown as net.Socket;
      });

      await handler.handleOpen({ tunnelId: 't1', target: '/run/code-server.sock' });

      expect(relaySend.send).toHaveBeenCalledWith({
        type: 'tunnel_open_ack',
        tunnelId: 't1',
        status: 'error',
        error: 'ECONNREFUSED',
      });
    });
  });

  // -------------------------------------------------------------------------
  // handleData
  // -------------------------------------------------------------------------
  describe('handleData', () => {
    it('decodes base64 and writes to socket', async () => {
      await handler.handleOpen({ tunnelId: 't1', target: '/run/code-server.sock' });

      const payload = Buffer.from('hello world').toString('base64');
      handler.handleData({ tunnelId: 't1', data: payload });

      // Retrieve the mock socket created during handleOpen
      const mockSocket = (net.createConnection as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as MockSocket;
      expect(mockSocket.write).toHaveBeenCalledWith(Buffer.from('hello world'));
    });

    it('calls codeServerManager.touch()', async () => {
      await handler.handleOpen({ tunnelId: 't1', target: '/run/code-server.sock' });

      // Reset so we only measure calls from handleData
      (codeServerManager.touch as ReturnType<typeof vi.fn>).mockClear();

      handler.handleData({ tunnelId: 't1', data: Buffer.from('x').toString('base64') });

      expect(codeServerManager.touch).toHaveBeenCalledTimes(1);
    });

    it('silently drops data for unknown tunnelId', () => {
      // Should not throw
      expect(() => {
        handler.handleData({ tunnelId: 'nonexistent', data: Buffer.from('x').toString('base64') });
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // handleClose
  // -------------------------------------------------------------------------
  describe('handleClose', () => {
    it('destroys socket and removes from map', async () => {
      await handler.handleOpen({ tunnelId: 't1', target: '/run/code-server.sock' });

      const mockSocket = (net.createConnection as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as MockSocket;

      handler.handleClose({ tunnelId: 't1' });

      expect(mockSocket.destroy).toHaveBeenCalled();

      // Subsequent handleData should silently drop (tunnel removed)
      (mockSocket.write as ReturnType<typeof vi.fn>).mockClear();
      handler.handleData({ tunnelId: 't1', data: Buffer.from('x').toString('base64') });
      expect(mockSocket.write).not.toHaveBeenCalled();
    });

    it('no-ops for unknown tunnelId', () => {
      expect(() => {
        handler.handleClose({ tunnelId: 'nonexistent' });
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // cleanup
  // -------------------------------------------------------------------------
  describe('cleanup', () => {
    it('destroys all sockets and clears map', async () => {
      // Open two tunnels
      await handler.handleOpen({ tunnelId: 't1', target: '/run/code-server.sock' });
      await handler.handleOpen({ tunnelId: 't2', target: '/run/code-server.sock' });

      const mockSocket1 = (net.createConnection as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as MockSocket;
      const mockSocket2 = (net.createConnection as unknown as ReturnType<typeof vi.fn>).mock.results[1].value as MockSocket;

      handler.cleanup();

      expect(mockSocket1.destroy).toHaveBeenCalled();
      expect(mockSocket2.destroy).toHaveBeenCalled();

      // Subsequent handleData calls should be silently dropped
      (mockSocket1.write as ReturnType<typeof vi.fn>).mockClear();
      (mockSocket2.write as ReturnType<typeof vi.fn>).mockClear();
      handler.handleData({ tunnelId: 't1', data: Buffer.from('a').toString('base64') });
      handler.handleData({ tunnelId: 't2', data: Buffer.from('b').toString('base64') });
      expect(mockSocket1.write).not.toHaveBeenCalled();
      expect(mockSocket2.write).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Socket data relay (socket -> relay)
  // -------------------------------------------------------------------------
  describe('socket data relay', () => {
    it('forwards socket data to relay as base64-encoded tunnel_data messages', async () => {
      await handler.handleOpen({ tunnelId: 't1', target: '/run/code-server.sock' });

      const mockSocket = (net.createConnection as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as MockSocket;

      // Clear previous send calls (open ack)
      (relaySend.send as ReturnType<typeof vi.fn>).mockClear();

      // Simulate data arriving on the unix socket
      const chunk = Buffer.from('response data');
      mockSocket.emit('data', chunk);

      expect(relaySend.send).toHaveBeenCalledWith({
        type: 'tunnel_data',
        tunnelId: 't1',
        data: chunk.toString('base64'),
      });
    });

    it('sends tunnel_close when socket closes unexpectedly', async () => {
      await handler.handleOpen({ tunnelId: 't1', target: '/run/code-server.sock' });

      const mockSocket = (net.createConnection as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as MockSocket;

      (relaySend.send as ReturnType<typeof vi.fn>).mockClear();

      // Simulate the socket closing on its own (not via handleClose)
      mockSocket.emit('close');

      expect(relaySend.send).toHaveBeenCalledWith({
        type: 'tunnel_close',
        tunnelId: 't1',
        reason: 'socket closed',
      });
    });
  });
});
