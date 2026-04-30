import http from 'node:http';

export type ClusterStatus = 'bootstrapping' | 'ready' | 'degraded' | 'error';

const DEFAULT_SOCKET_PATH = '/run/generacy-control-plane/control.sock';
const DEFAULT_TIMEOUT = 5_000;

export interface StatusReporterOptions {
  socketPath?: string;
  timeout?: number;
}

export class StatusReporter {
  private readonly socketPath: string;
  private readonly timeout: number;

  constructor(options: StatusReporterOptions = {}) {
    this.socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
  }

  async pushStatus(
    status: ClusterStatus,
    statusReason?: string,
  ): Promise<void> {
    const body = JSON.stringify({ status, statusReason });

    return new Promise<void>((resolve) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path: '/internal/status',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          // Consume response body to free socket
          res.resume();
          res.on('end', resolve);
        },
      );

      req.setTimeout(this.timeout, () => {
        req.destroy();
        resolve();
      });

      req.on('error', () => {
        // Fire-and-forget: swallow errors
        resolve();
      });

      req.write(body);
      req.end();
    });
  }
}
