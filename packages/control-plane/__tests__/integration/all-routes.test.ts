import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ControlPlaneServer } from '../../src/server.js';

let server: ControlPlaneServer;
let socketPath: string;

function request(
  method: string,
  urlPath: string,
  body?: object,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const reqHeaders: Record<string, string> = {
      ...(headers ?? {}),
    };
    if (data) {
      reqHeaders['content-type'] = 'application/json';
      reqHeaders['content-length'] = Buffer.byteLength(data).toString();
    }

    const req = http.request(
      {
        socketPath,
        method,
        path: urlPath,
        headers: reqHeaders,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

describe('integration: all routes', () => {
  beforeAll(async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-test-'));
    socketPath = path.join(tmpDir, 'control.sock');
    server = new ControlPlaneServer();
    await server.start(socketPath);
  });

  afterAll(async () => {
    await server.close();
  });

  // GET /state
  it('GET /state returns cluster state', async () => {
    const res = await request('GET', '/state');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('status', 'ready');
    expect(body).toHaveProperty('deploymentMode', 'local');
    expect(body).toHaveProperty('variant', 'cluster-base');
    expect(body).toHaveProperty('lastSeen');
    expect(typeof body['lastSeen']).toBe('string');
  });

  // GET /credentials/:id
  it('GET /credentials/:id returns stub credential', async () => {
    const res = await request('GET', '/credentials/my-cred');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('id', 'my-cred');
    expect(body).toHaveProperty('type');
    expect(body).toHaveProperty('backend');
    expect(body).toHaveProperty('backendKey');
    expect(body).toHaveProperty('status', 'active');
    expect(body).toHaveProperty('createdAt');
  });

  // PUT /credentials/:id
  it('PUT /credentials/:id accepts body', async () => {
    const res = await request('PUT', '/credentials/my-cred', { type: 'api-key' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  // GET /roles/:id
  it('GET /roles/:id returns stub role', async () => {
    const res = await request('GET', '/roles/my-role');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('id', 'my-role');
    expect(body).toHaveProperty('description');
    expect(body).toHaveProperty('credentials');
    expect(Array.isArray(body['credentials'])).toBe(true);
  });

  // PUT /roles/:id
  it('PUT /roles/:id accepts body', async () => {
    const res = await request('PUT', '/roles/my-role', { description: 'updated' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  // POST /lifecycle/:action (valid)
  it('POST /lifecycle/clone-peer-repos returns accepted', async () => {
    const res = await request('POST', '/lifecycle/clone-peer-repos');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, action: 'clone-peer-repos' });
  });

  it('POST /lifecycle/code-server-start returns accepted', async () => {
    const res = await request('POST', '/lifecycle/code-server-start');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, action: 'code-server-start' });
  });

  // POST /lifecycle/:action (invalid)
  it('POST /lifecycle/invalid returns 400 UNKNOWN_ACTION', async () => {
    const res = await request('POST', '/lifecycle/invalid');
    expect(res.status).toBe(400);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('code', 'UNKNOWN_ACTION');
    expect(body).toHaveProperty('error');
  });

  // 404 for unknown route
  it('GET /unknown returns 404 NOT_FOUND', async () => {
    const res = await request('GET', '/unknown');
    expect(res.status).toBe(404);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('code', 'NOT_FOUND');
  });

  // Method not allowed
  it('POST /state returns 400 INVALID_REQUEST', async () => {
    const res = await request('POST', '/state');
    expect(res.status).toBe(400);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('code', 'INVALID_REQUEST');
  });

  // Actor headers parsed
  it('requests with actor headers are accepted', async () => {
    const res = await request('GET', '/state', undefined, {
      'x-generacy-actor-user-id': 'user-123',
      'x-generacy-actor-session-id': 'session-456',
    });
    expect(res.status).toBe(200);
  });
});
