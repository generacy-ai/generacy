import http from 'node:http';

import { CredentialStore } from './credential-store.js';
import { CredhelperError, sendError } from './errors.js';

/**
 * Create a per-session data server that serves credentials over a Unix socket.
 * Routes: GET /credential/:credentialId → returns { value: string }
 */
export function createDataServer(
  sessionId: string,
  store: CredentialStore,
  _socketPath: string,
): http.Server {
  return http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    // GET /credential/:credentialId
    const credMatch = url.match(/^\/credential\/([^/]+)$/);
    if (method === 'GET' && credMatch) {
      const credentialId = credMatch[1]!;
      const entry = store.get(sessionId, credentialId);

      if (!entry) {
        sendError(
          res,
          new CredhelperError(
            'CREDENTIAL_NOT_FOUND',
            `Credential not found: ${credentialId}`,
            { credentialId, sessionId },
          ),
        );
        return;
      }

      if (!entry.available || entry.expiresAt.getTime() < Date.now()) {
        sendError(
          res,
          new CredhelperError(
            'CREDENTIAL_EXPIRED',
            `Credential expired: ${credentialId}`,
            { credentialId, sessionId },
          ),
        );
        return;
      }

      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ value: entry.value.value }));
      return;
    }

    // Unknown route
    sendError(
      res,
      new CredhelperError('INVALID_REQUEST', `Not found: ${method} ${url}`),
    );
  });
}
