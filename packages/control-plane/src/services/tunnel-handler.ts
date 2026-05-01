import net from 'node:net';
import type { CodeServerManager } from './code-server-manager.js';

export interface RelayMessageSender {
  send(message: unknown): void;
}

interface TunnelOpenMessage {
  tunnelId: string;
  target: string;
}

interface TunnelDataMessage {
  tunnelId: string;
  data: string;
}

interface TunnelCloseMessage {
  tunnelId: string;
  reason?: string;
}

export class TunnelHandler {
  private readonly tunnels: Map<string, net.Socket> = new Map();

  constructor(
    private readonly relaySend: RelayMessageSender,
    private readonly codeServerManager: CodeServerManager,
    private readonly allowedTarget: string = '/run/code-server.sock',
  ) {}

  async handleOpen(msg: TunnelOpenMessage): Promise<void> {
    const { tunnelId, target } = msg;

    // FR-004: Restrict target to allowed path only
    if (target !== this.allowedTarget) {
      this.relaySend.send({
        type: 'tunnel_open_ack',
        tunnelId,
        status: 'error',
        error: 'invalid target',
      });
      return;
    }

    try {
      // FR-005: Auto-start code-server if not running
      await this.codeServerManager.start();

      // Wait for socket with 10s timeout
      const socket = await this.connectWithTimeout(target, 10_000);

      // Store in map
      this.tunnels.set(tunnelId, socket);

      // Wire socket data → relay (base64 encode)
      socket.on('data', (chunk: Buffer) => {
        this.relaySend.send({
          type: 'tunnel_data',
          tunnelId,
          data: chunk.toString('base64'),
        });
      });

      // FR-007: Handle abrupt socket disconnects
      const onSocketEnd = () => {
        if (this.tunnels.has(tunnelId)) {
          this.tunnels.delete(tunnelId);
          this.relaySend.send({
            type: 'tunnel_close',
            tunnelId,
            reason: 'socket closed',
          });
        }
      };
      socket.on('close', onSocketEnd);
      socket.on('error', () => {
        socket.destroy();
        onSocketEnd();
      });

      // Send success ack
      this.relaySend.send({
        type: 'tunnel_open_ack',
        tunnelId,
        status: 'ok',
      });
    } catch (err) {
      this.relaySend.send({
        type: 'tunnel_open_ack',
        tunnelId,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  handleData(msg: TunnelDataMessage): void {
    const socket = this.tunnels.get(msg.tunnelId);
    if (!socket) return; // silently drop if tunnel not found

    const buf = Buffer.from(msg.data, 'base64');
    socket.write(buf);

    // FR-006: Reset code-server idle timer
    this.codeServerManager.touch();
  }

  handleClose(msg: TunnelCloseMessage): void {
    const socket = this.tunnels.get(msg.tunnelId);
    if (!socket) return; // no-op if tunnel not found

    this.tunnels.delete(msg.tunnelId);
    socket.destroy();
  }

  cleanup(): void {
    for (const [tunnelId, socket] of this.tunnels) {
      socket.destroy();
      this.tunnels.delete(tunnelId);
    }
  }

  private connectWithTimeout(socketPath: string, timeoutMs: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timeout connecting to ${socketPath} after ${timeoutMs}ms`));
      }, timeoutMs);

      const socket = net.createConnection({ path: socketPath }, () => {
        clearTimeout(timer);
        resolve(socket);
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
