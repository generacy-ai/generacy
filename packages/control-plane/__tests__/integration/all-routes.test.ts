import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ControlPlaneServer } from '../../src/server.js';
import {
  setCodeServerManager,
  type CodeServerManager,
} from '../../src/services/code-server-manager.js';
import { initClusterState } from '../../src/state.js';
import { ClusterLocalBackend } from '@generacy-ai/credhelper';
import { setCredentialBackend } from '../../src/services/credential-writer.js';

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
  const fakeCodeServer: CodeServerManager = {
    start: vi.fn(async () => ({ status: 'starting' as const, socket_path: '/run/code-server.sock' })),
    stop: vi.fn(async () => {}),
    touch: vi.fn(),
    getStatus: vi.fn(() => 'stopped' as const),
    shutdown: vi.fn(async () => {}),
  };

  let tmpDir: string;

  beforeAll(async () => {
    setCodeServerManager(fakeCodeServer);
    initClusterState({ deploymentMode: 'local', variant: 'cluster-base' });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-test-'));
    socketPath = path.join(tmpDir, 'control.sock');

    // Initialize credential backend for credential route tests
    const agencyDir = path.join(tmpDir, '.agency');
    await fs.mkdir(agencyDir, { recursive: true });
    process.env['CREDHELPER_AGENCY_DIR'] = agencyDir;

    const backend = new ClusterLocalBackend({
      dataPath: path.join(tmpDir, 'credentials.dat'),
      keyPath: path.join(tmpDir, 'master.key'),
    });
    await backend.init();
    setCredentialBackend(backend);

    server = new ControlPlaneServer();
    await server.start(socketPath);
  });

  afterAll(async () => {
    await server.close();
    setCodeServerManager(null);
    delete process.env['CREDHELPER_AGENCY_DIR'];
  });

  // GET /state
  it('GET /state returns cluster state', async () => {
    const res = await request('GET', '/state');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('deploymentMode', 'local');
    expect(body).toHaveProperty('variant', 'cluster-base');
    expect(body).toHaveProperty('lastSeen');
    expect(typeof body['lastSeen']).toBe('string');
  });

  // GET /credentials/:id — returns 404 when credential doesn't exist
  it('GET /credentials/:id returns 404 for nonexistent credential', async () => {
    const res = await request('GET', '/credentials/nonexistent-cred');
    expect(res.status).toBe(404);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('code', 'NOT_FOUND');
  });

  // PUT /credentials/:id
  it('PUT /credentials/:id accepts body with actor header', async () => {
    const res = await request('PUT', '/credentials/my-cred', { type: 'api-key', value: 'sk-test' }, {
      'x-generacy-actor-user-id': 'user-123',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('PUT /credentials/:id without actor header returns 401', async () => {
    const res = await request('PUT', '/credentials/my-cred', { type: 'api-key' });
    expect(res.status).toBe(401);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('code', 'UNAUTHORIZED');
    expect(body).toHaveProperty('error', 'Missing actor identity');
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
  it('PUT /roles/:id accepts body with actor header', async () => {
    const res = await request('PUT', '/roles/my-role', { description: 'updated' }, {
      'x-generacy-actor-user-id': 'user-123',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('PUT /roles/:id without actor header returns 401', async () => {
    const res = await request('PUT', '/roles/my-role', { description: 'updated' });
    expect(res.status).toBe(401);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('code', 'UNAUTHORIZED');
    expect(body).toHaveProperty('error', 'Missing actor identity');
  });

  // POST /lifecycle/:action (valid)
  const actorHeaders = { 'x-generacy-actor-user-id': 'user-123' };

  it('POST /lifecycle/clone-peer-repos returns accepted', async () => {
    const res = await request('POST', '/lifecycle/clone-peer-repos', { repos: [] }, actorHeaders);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, action: 'clone-peer-repos' });
  });

  it('POST /lifecycle/code-server-start returns runtime status + socket_path', async () => {
    const res = await request('POST', '/lifecycle/code-server-start', undefined, actorHeaders);
    expect(res.status).toBe(200);
    expect(fakeCodeServer.start).toHaveBeenCalled();
    expect(res.body).toEqual({ status: 'starting', socket_path: '/run/code-server.sock' });
  });

  it('POST /lifecycle/code-server-stop calls manager.stop and returns accepted', async () => {
    const res = await request('POST', '/lifecycle/code-server-stop', undefined, actorHeaders);
    expect(res.status).toBe(200);
    expect(fakeCodeServer.stop).toHaveBeenCalled();
    expect(res.body).toEqual({ accepted: true, action: 'code-server-stop' });
  });

  // POST /lifecycle/:action (invalid)
  it('POST /lifecycle/invalid returns 400 UNKNOWN_ACTION', async () => {
    const res = await request('POST', '/lifecycle/invalid', undefined, actorHeaders);
    expect(res.status).toBe(400);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('code', 'UNKNOWN_ACTION');
    expect(body).toHaveProperty('error');
  });

  it('POST /lifecycle/:action without actor header returns 401', async () => {
    const res = await request('POST', '/lifecycle/clone-peer-repos');
    expect(res.status).toBe(401);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('code', 'UNAUTHORIZED');
    expect(body).toHaveProperty('error', 'Missing actor identity');
  });

  // POST /internal/status
  it('POST /internal/status accepts valid status update', async () => {
    const res = await request('POST', '/internal/status', { status: 'ready' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('POST /internal/status round-trip: status reflected in GET /state', async () => {
    await request('POST', '/internal/status', { status: 'degraded', statusReason: 'Relay lost' });
    const res = await request('GET', '/state');
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('status', 'degraded');
    expect(body).toHaveProperty('statusReason', 'Relay lost');
  });

  it('POST /internal/status rejects invalid status', async () => {
    const res = await request('POST', '/internal/status', { status: 'nope' });
    expect(res.status).toBe(400);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('code', 'INVALID_REQUEST');
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
