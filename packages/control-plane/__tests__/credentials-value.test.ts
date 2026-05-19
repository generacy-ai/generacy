import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClusterLocalBackend } from '@generacy-ai/credhelper';
import { setCredentialBackend } from '../src/services/credential-writer.js';
import { handleGetCredentialValue } from '../src/routes/credentials.js';
import type { ActorContext } from '../src/context.js';

// Mock relay events
const mockPushEvent = vi.fn();
vi.mock('../src/relay-events.js', () => ({
  getRelayPushEvent: () => mockPushEvent,
}));

function createMockReq(method: string, url: string) {
  return { method, url, headers: {} } as unknown as http.IncomingMessage;
}

function createMockRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) { res.headers[name] = value; },
    writeHead(status: number) { res.statusCode = status; },
    end(data?: string) { res.body = data ?? ''; },
  };
  return res as unknown as http.ServerResponse & { statusCode: number; body: string };
}

const actor: ActorContext = { userId: 'test-user', sessionId: 'test-session' };

describe('handleGetCredentialValue', () => {
  let tmpDir: string;
  let backend: ClusterLocalBackend;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-value-test-'));
    backend = new ClusterLocalBackend({
      dataPath: path.join(tmpDir, 'credentials.dat'),
      keyPath: path.join(tmpDir, 'master.key'),
    });
    await backend.init();
    setCredentialBackend(backend);
    mockPushEvent.mockClear();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns { value } when backend has the credential', async () => {
    const secretValue = JSON.stringify({ username: '_token', password: 'ghp_test123' });
    await backend.setSecret('registry-ghcr.io', secretValue);

    const req = createMockReq('GET', '/credentials/registry-ghcr.io/value');
    const res = createMockRes();

    await handleGetCredentialValue(req, res, actor, { id: 'registry-ghcr.io' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ value: secretValue });
  });

  it('returns 404 when credential not found', async () => {
    const req = createMockReq('GET', '/credentials/registry-nonexistent.io/value');
    const res = createMockRes();

    await handleGetCredentialValue(req, res, actor, { id: 'registry-nonexistent.io' });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('CREDENTIAL_NOT_FOUND');
    expect(body.error).toContain('registry-nonexistent.io');
  });

  it('returns 500 when backend is not initialized', async () => {
    setCredentialBackend(undefined as unknown as ClusterLocalBackend);

    const req = createMockReq('GET', '/credentials/registry-ghcr.io/value');
    const res = createMockRes();

    await handleGetCredentialValue(req, res, actor, { id: 'registry-ghcr.io' });

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('BACKEND_ERROR');
  });

  it('emits audit relay event on success', async () => {
    const secretValue = '{"username":"u","password":"p"}';
    await backend.setSecret('registry-ghcr.io', secretValue);

    const req = createMockReq('GET', '/credentials/registry-ghcr.io/value');
    const res = createMockRes();

    await handleGetCredentialValue(req, res, actor, { id: 'registry-ghcr.io' });

    expect(res.statusCode).toBe(200);
    expect(mockPushEvent).toHaveBeenCalledWith('cluster.credentials', expect.objectContaining({
      action: 'credential_value_read',
      credentialId: 'registry-ghcr.io',
    }));
  });
});
