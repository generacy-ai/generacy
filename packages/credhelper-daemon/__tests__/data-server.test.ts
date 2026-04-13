import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDataServer } from '../src/data-server.js';
import { CredentialStore } from '../src/credential-store.js';
import type { CredentialCacheEntry } from '../src/types.js';

function makeEntry(overrides?: Partial<CredentialCacheEntry>): CredentialCacheEntry {
  return {
    value: { value: 'secret-val' },
    expiresAt: new Date(Date.now() + 3600000),
    available: true,
    credentialType: 'mock',
    ...overrides,
  };
}

function request(
  socketPath: string,
  method: string,
  urlPath: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: urlPath }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode!, body: JSON.parse(raw) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('createDataServer', () => {
  const sessionId = 'test-session-1';
  let store: CredentialStore;
  let server: http.Server;
  let socketPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'credhelper-data-test-'));
    socketPath = path.join(tmpDir, 'data.sock');

    store = new CredentialStore();
    server = createDataServer(sessionId, store, socketPath);

    await new Promise<void>((resolve) => {
      server.listen(socketPath, resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /credential/:id returns value for a valid credential', async () => {
    store.set(sessionId, 'cred-abc', makeEntry({ value: { value: 'my-secret-token' } }));

    const res = await request(socketPath, 'GET', '/credential/cred-abc');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ value: 'my-secret-token' });
  });

  it('returns 404 for unknown credential', async () => {
    const res = await request(socketPath, 'GET', '/credential/nonexistent');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CREDENTIAL_NOT_FOUND');
  });

  it('returns 410 for expired credential (expiresAt in the past)', async () => {
    store.set(
      sessionId,
      'cred-expired',
      makeEntry({ expiresAt: new Date(Date.now() - 10000) }),
    );

    const res = await request(socketPath, 'GET', '/credential/cred-expired');

    expect(res.status).toBe(410);
    expect(res.body.code).toBe('CREDENTIAL_EXPIRED');
  });

  it('returns 410 for unavailable credential (available: false)', async () => {
    store.set(
      sessionId,
      'cred-unavail',
      makeEntry({ available: false }),
    );

    const res = await request(socketPath, 'GET', '/credential/cred-unavail');

    expect(res.status).toBe(410);
    expect(res.body.code).toBe('CREDENTIAL_EXPIRED');
  });

  it('unknown routes return 400', async () => {
    const res = await request(socketPath, 'GET', '/something/else');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REQUEST');
  });
});
