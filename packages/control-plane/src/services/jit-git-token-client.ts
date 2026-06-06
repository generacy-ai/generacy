import http from 'node:http';

export type JitTokenErrorCode =
  | 'CLUSTER_API_KEY_MISSING'
  | 'CREDENTIAL_NOT_CONFIGURED'
  | 'CLOUD_UNREACHABLE'
  | 'CLOUD_AUTH_REJECTED'
  | 'CLOUD_REQUEST_INVALID'
  | 'CLOUD_UPSTREAM_ERROR'
  | 'CLOUD_RESPONSE_INVALID'
  | 'CONTROL_SOCKET_UNREACHABLE'
  | 'RESPONSE_PARSE_ERROR';

const KNOWN_ERROR_CODES: ReadonlySet<JitTokenErrorCode> = new Set<JitTokenErrorCode>([
  'CLUSTER_API_KEY_MISSING',
  'CREDENTIAL_NOT_CONFIGURED',
  'CLOUD_UNREACHABLE',
  'CLOUD_AUTH_REJECTED',
  'CLOUD_REQUEST_INVALID',
  'CLOUD_UPSTREAM_ERROR',
  'CLOUD_RESPONSE_INVALID',
  'CONTROL_SOCKET_UNREACHABLE',
  'RESPONSE_PARSE_ERROR',
]);

export class JitTokenError extends Error {
  readonly code: JitTokenErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: JitTokenErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'JitTokenError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export interface JitGitTokenResponse {
  token: string;
  expiresAt: Date;
}

export interface JitGitTokenClient {
  fetch(credentialId?: string): Promise<JitGitTokenResponse>;
}

export interface JitGitTokenClientOptions {
  socketPath: string;
  logger?: { warn(obj: Record<string, unknown>, msg: string): void };
}

interface SocketResponse {
  status: number;
  body: string;
}

function postToControlSocket(socketPath: string, body: string): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: '/git-token',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export function createJitGitTokenClient(options: JitGitTokenClientOptions): JitGitTokenClient {
  const { socketPath, logger } = options;

  return {
    async fetch(credentialId?: string): Promise<JitGitTokenResponse> {
      const body = credentialId === undefined ? '{}' : JSON.stringify({ credentialId });

      let response: SocketResponse;
      try {
        response = await postToControlSocket(socketPath, body);
      } catch (err) {
        const cause = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
        throw new JitTokenError(
          'CONTROL_SOCKET_UNREACHABLE',
          `control socket at ${socketPath} unreachable (${cause})`,
          { cause },
        );
      }

      if (response.status >= 200 && response.status < 300) {
        let parsed: { token?: unknown; expiresAt?: unknown };
        try {
          parsed = JSON.parse(response.body) as typeof parsed;
        } catch {
          logger?.warn(
            { socketPath, status: response.status },
            'jit-git-token-client: non-JSON success body',
          );
          throw new JitTokenError(
            'RESPONSE_PARSE_ERROR',
            'control-plane returned a non-JSON body on success',
          );
        }
        if (typeof parsed.token !== 'string' || parsed.token.length === 0) {
          throw new JitTokenError(
            'RESPONSE_PARSE_ERROR',
            'control-plane response missing token',
          );
        }
        if (typeof parsed.expiresAt !== 'string') {
          throw new JitTokenError(
            'RESPONSE_PARSE_ERROR',
            'control-plane response missing expiresAt',
          );
        }
        const expiresAtMs = Date.parse(parsed.expiresAt);
        if (!Number.isFinite(expiresAtMs)) {
          throw new JitTokenError(
            'RESPONSE_PARSE_ERROR',
            `control-plane returned an unparseable expiresAt: ${parsed.expiresAt}`,
          );
        }
        return { token: parsed.token, expiresAt: new Date(expiresAtMs) };
      }

      // Non-2xx — extract code/message from error body if possible.
      let code: JitTokenErrorCode = 'CLOUD_UPSTREAM_ERROR';
      let message = `HTTP ${response.status}`;
      let details: Record<string, unknown> | undefined;
      try {
        const errBody = JSON.parse(response.body) as {
          code?: unknown;
          error?: unknown;
          details?: unknown;
        };
        if (typeof errBody.code === 'string' && KNOWN_ERROR_CODES.has(errBody.code as JitTokenErrorCode)) {
          code = errBody.code as JitTokenErrorCode;
        }
        if (typeof errBody.error === 'string') {
          message = errBody.error;
        }
        if (errBody.details && typeof errBody.details === 'object') {
          details = errBody.details as Record<string, unknown>;
        }
      } catch {
        // Body was empty / not JSON — keep defaults.
      }
      throw new JitTokenError(code, message, details);
    },
  };
}
