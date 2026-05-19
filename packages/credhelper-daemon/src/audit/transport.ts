import http from 'node:http';

import type { AuditBatch } from './types.js';

/**
 * Flush an audit batch to the control-plane via HTTP POST over Unix socket.
 * Silently swallows errors — entries stay in the ring buffer (bounded by capacity).
 */
export function flushBatch(batch: AuditBatch, socketPath: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const body = JSON.stringify(batch);

    const req = http.request(
      {
        socketPath,
        method: 'POST',
        path: '/internal/audit-batch',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        // Consume response body to free the socket
        res.resume();
        resolve();
      },
    );

    req.on('error', () => {
      // Control-plane unavailable — swallow error, entries stay in ring buffer
      resolve();
    });

    req.end(body);
  });
}
