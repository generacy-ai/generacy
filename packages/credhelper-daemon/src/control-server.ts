import http from 'node:http';
import net from 'node:net';

import { SessionManager } from './session-manager.js';
import { CredhelperError, sendError } from './errors.js';
import { verifyPeer } from './peer-cred.js';
import type { SessionTokenStore } from './auth/session-token-store.js';

/**
 * HTTP server bound to the control socket. Handles session begin/end.
 *
 * Routes:
 *   POST /sessions        → beginSession
 *   DELETE /sessions/:id  → endSession
 */
export class ControlServer {
  private server: http.Server;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly workerUid: number,
    private readonly enablePeerCred: boolean,
    private readonly sessionTokenStore?: SessionTokenStore,
  ) {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        if (err instanceof CredhelperError) {
          sendError(res, err);
        } else {
          sendError(
            res,
            new CredhelperError(
              'INTERNAL_ERROR',
              err instanceof Error ? err.message : 'Internal error',
            ),
          );
        }
      });
    });

    // SO_PEERCRED check on connection
    this.server.on('connection', (socket: net.Socket) => {
      try {
        verifyPeer(socket, this.workerUid, this.enablePeerCred);
      } catch (err) {
        socket.destroy();
      }
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    // POST /sessions
    if (method === 'POST' && url === '/sessions') {
      const body = await readBody(req);
      let parsed: { role?: string; session_id?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new CredhelperError('INVALID_REQUEST', 'Invalid JSON body');
      }

      if (!parsed.role || !parsed.session_id) {
        throw new CredhelperError(
          'INVALID_REQUEST',
          'Missing required fields: role, session_id',
        );
      }

      const result = await this.sessionManager.beginSession({
        role: parsed.role,
        sessionId: parsed.session_id,
      });

      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(
        JSON.stringify({
          session_dir: result.sessionDir,
          expires_at: result.expiresAt.toISOString(),
        }),
      );
      return;
    }

    // DELETE /sessions/:id
    const deleteMatch = url.match(/^\/sessions\/([^/]+)$/);
    if (method === 'DELETE' && deleteMatch) {
      const sessionId = deleteMatch[1]!;
      await this.sessionManager.endSession(sessionId);

      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // PUT /auth/session-token
    if (method === 'PUT' && url === '/auth/session-token') {
      if (!this.sessionTokenStore) {
        throw new CredhelperError('INTERNAL_ERROR', 'Session token store not configured');
      }
      const body = await readBody(req);
      let parsed: { token?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new CredhelperError('MALFORMED_REQUEST', 'Invalid JSON body');
      }
      if (!parsed.token || typeof parsed.token !== 'string') {
        throw new CredhelperError('MALFORMED_REQUEST', 'Missing required field: token');
      }
      await this.sessionTokenStore.setToken(parsed.token);
      res.writeHead(204);
      res.end();
      return;
    }

    // DELETE /auth/session-token
    if (method === 'DELETE' && url === '/auth/session-token') {
      if (!this.sessionTokenStore) {
        throw new CredhelperError('INTERNAL_ERROR', 'Session token store not configured');
      }
      await this.sessionTokenStore.clearToken();
      res.writeHead(204);
      res.end();
      return;
    }

    // GET /auth/session-token/status
    if (method === 'GET' && url === '/auth/session-token/status') {
      if (!this.sessionTokenStore) {
        throw new CredhelperError('INTERNAL_ERROR', 'Session token store not configured');
      }
      const status = this.sessionTokenStore.getStatus();
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(status));
      return;
    }

    // Unknown route
    throw new CredhelperError(
      'INVALID_REQUEST',
      `Not found: ${method} ${url}`,
    );
  }

  start(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      this.server.listen(socketPath, () => resolve());
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
