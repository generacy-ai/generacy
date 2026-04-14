import http from 'node:http';
import { CredhelperUnavailableError, CredhelperSessionError } from './credhelper-errors.js';

export interface BeginSessionResult {
  sessionDir: string;
  expiresAt: Date;
}

export interface CredhelperClientOptions {
  /** Unix socket path. Default: /run/generacy-credhelper/control.sock */
  socketPath?: string;
  /** Connection timeout in ms. Default: 5000 */
  connectTimeout?: number;
  /** Request timeout in ms. Default: 30000 */
  requestTimeout?: number;
}

export interface CredhelperClient {
  beginSession(role: string, sessionId: string): Promise<BeginSessionResult>;
  endSession(sessionId: string): Promise<void>;
}

const DEFAULT_SOCKET_PATH = '/run/generacy-credhelper/control.sock';
const DEFAULT_CONNECT_TIMEOUT = 5_000;
const DEFAULT_REQUEST_TIMEOUT = 30_000;

export class CredhelperHttpClient implements CredhelperClient {
  private readonly socketPath: string;
  private readonly connectTimeout: number;
  private readonly requestTimeout: number;

  constructor(options: CredhelperClientOptions = {}) {
    this.socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
    this.connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
  }

  async beginSession(role: string, sessionId: string): Promise<BeginSessionResult> {
    const body = JSON.stringify({ role, session_id: sessionId });

    const response = await this.request('POST', '/sessions', body);

    if (response.statusCode !== 200) {
      const parsed = JSON.parse(response.body) as { error?: string; code?: string };
      throw new CredhelperSessionError(
        parsed.code ?? 'UNKNOWN',
        parsed.error ?? `HTTP ${response.statusCode}`,
        role,
        sessionId,
      );
    }

    const parsed = JSON.parse(response.body) as { session_dir: string; expires_at: string };
    return {
      sessionDir: parsed.session_dir,
      expiresAt: new Date(parsed.expires_at),
    };
  }

  async endSession(sessionId: string): Promise<void> {
    const response = await this.request('DELETE', `/sessions/${encodeURIComponent(sessionId)}`);

    if (response.statusCode !== 200) {
      const parsed = JSON.parse(response.body) as { error?: string; code?: string };
      throw new CredhelperSessionError(
        parsed.code ?? 'UNKNOWN',
        parsed.error ?? `HTTP ${response.statusCode}`,
        'unknown',
        sessionId,
      );
    }
  }

  private request(
    method: string,
    path: string,
    body?: string,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const connectTimer = setTimeout(() => {
        req.destroy();
        reject(new CredhelperUnavailableError(this.socketPath));
      }, this.connectTimeout);

      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: {
            ...(body !== undefined && {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            }),
          },
        },
        (res) => {
          clearTimeout(connectTimer);

          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });

          res.on('end', () => {
            resolve({ statusCode: res.statusCode ?? 500, body: data });
          });
        },
      );

      req.setTimeout(this.requestTimeout, () => {
        req.destroy();
        reject(new CredhelperUnavailableError(this.socketPath));
      });

      req.on('error', (err) => {
        clearTimeout(connectTimer);
        reject(new CredhelperUnavailableError(this.socketPath, err));
      });

      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
  }
}
