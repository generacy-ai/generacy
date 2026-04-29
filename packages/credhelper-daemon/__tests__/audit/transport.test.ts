import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { flushBatch } from '../../src/audit/transport.js';
import type { AuditBatch } from '../../src/audit/types.js';

function makeBatch(count: number): AuditBatch {
  return {
    entries: Array.from({ length: count }, (_, i) => ({
      timestamp: new Date().toISOString(),
      action: 'credential.mint' as const,
      actor: { workerId: 'w1' },
      clusterId: 'c1',
      success: true,
      credentialId: `cred-${i}`,
    })),
    droppedSinceLastBatch: 0,
  };
}

describe('flushBatch', () => {
  let server: http.Server | null = null;
  let socketPath: string;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    try {
      await fs.unlink(socketPath);
    } catch {
      // ignore
    }
  });

  it('sends batch to control-plane and resolves', async () => {
    socketPath = path.join(os.tmpdir(), `audit-test-${Date.now()}.sock`);
    let receivedBody = '';

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString();
        res.writeHead(200);
        res.end('ok');
      });
    });

    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));

    const batch = makeBatch(2);
    await flushBatch(batch, socketPath);

    const parsed = JSON.parse(receivedBody) as AuditBatch;
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.droppedSinceLastBatch).toBe(0);
  });

  it('resolves without throwing when control-plane is unavailable', async () => {
    socketPath = '/tmp/nonexistent-audit-socket.sock';
    const batch = makeBatch(1);

    // Should not throw
    await expect(flushBatch(batch, socketPath)).resolves.toBeUndefined();
  });
});
