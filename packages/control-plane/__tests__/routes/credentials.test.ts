import { Readable } from 'node:stream';
import type http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ActorContext } from '../../src/context.js';
import {
  handleGetCredential,
  handlePutCredential,
} from '../../src/routes/credentials.js';
import { ControlPlaneError } from '../../src/errors.js';
import { ClusterLocalBackend } from '@generacy-ai/credhelper';
import { setCredentialBackend } from '../../src/services/credential-writer.js';

function createMockResponse() {
  return {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(),
  };
}

function createBodyReq(body: object | string): http.IncomingMessage {
  const readable = new Readable({ read() {} });
  readable.push(typeof body === 'string' ? body : JSON.stringify(body));
  readable.push(null);
  return readable as unknown as http.IncomingMessage;
}

const stubActor: ActorContext = { userId: 'u-test', sessionId: 's-test' };

describe('handlePutCredential', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-route-test-'));
    const agencyDir = path.join(tmpDir, '.agency');
    await fs.mkdir(agencyDir, { recursive: true });

    const backend = new ClusterLocalBackend({
      dataPath: path.join(tmpDir, 'credentials.dat'),
      keyPath: path.join(tmpDir, 'master.key'),
    });
    await backend.init();
    setCredentialBackend(backend);

    process.env['CREDHELPER_AGENCY_DIR'] = agencyDir;
  });

  afterEach(async () => {
    delete process.env['CREDHELPER_AGENCY_DIR'];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns 200 with { ok: true }', async () => {
    const req = createBodyReq({ type: 'api-key', value: 'sk-test' });
    const res = createMockResponse();

    await handlePutCredential(req, res as any, stubActor, { id: 'cred-42' });

    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toEqual({ ok: true });
  });

  it('sets Content-Type to application/json', async () => {
    const req = createBodyReq({ type: 'api-key', value: 'sk-test' });
    const res = createMockResponse();

    await handlePutCredential(req, res as any, stubActor, { id: 'cred-42' });

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
  });

  it('throws UNAUTHORIZED when actor userId is missing', async () => {
    const req = createBodyReq({ type: 'api-key', value: 'val' });
    const res = createMockResponse();
    const noActor: ActorContext = {};

    await expect(
      handlePutCredential(req, res as any, noActor, { id: 'cred-42' }),
    ).rejects.toThrow(ControlPlaneError);

    try {
      const req2 = createBodyReq({ type: 'api-key', value: 'val' });
      await handlePutCredential(req2, res as any, noActor, { id: 'cred-42' });
    } catch (err) {
      expect((err as ControlPlaneError).code).toBe('UNAUTHORIZED');
      expect((err as ControlPlaneError).message).toBe('Missing actor identity');
    }
  });

  it('returns 400 on invalid JSON body', async () => {
    const req = createBodyReq('not-json');
    const res = createMockResponse();

    await handlePutCredential(req, res as any, stubActor, { id: 'cred-42' });

    expect(res.writeHead).toHaveBeenCalledWith(400);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.code).toBe('INVALID_REQUEST');
  });

  it('returns 400 on Zod validation failure', async () => {
    const req = createBodyReq({ type: '', value: '' });
    const res = createMockResponse();

    await handlePutCredential(req, res as any, stubActor, { id: 'cred-42' });

    expect(res.writeHead).toHaveBeenCalledWith(400);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.code).toBe('INVALID_REQUEST');
    expect(body.failedAt).toBe('validation');
  });
});

describe('handleGetCredential', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-get-test-'));
    const agencyDir = path.join(tmpDir, '.agency');
    await fs.mkdir(agencyDir, { recursive: true });

    const backend = new ClusterLocalBackend({
      dataPath: path.join(tmpDir, 'credentials.dat'),
      keyPath: path.join(tmpDir, 'master.key'),
    });
    await backend.init();
    setCredentialBackend(backend);

    process.env['CREDHELPER_AGENCY_DIR'] = agencyDir;
  });

  afterEach(async () => {
    delete process.env['CREDHELPER_AGENCY_DIR'];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns 404 for nonexistent credential', async () => {
    const req = {} as http.IncomingMessage;
    const res = createMockResponse();

    await handleGetCredential(req, res as any, stubActor, { id: 'nonexistent' });

    expect(res.writeHead).toHaveBeenCalledWith(404);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('returns metadata after PUT', async () => {
    // PUT first
    const putReq = createBodyReq({ type: 'api-key', value: 'sk-val' });
    const putRes = createMockResponse();
    await handlePutCredential(putReq, putRes as any, stubActor, { id: 'round-trip' });
    expect(putRes.writeHead).toHaveBeenCalledWith(200);

    // GET
    const req = {} as http.IncomingMessage;
    const res = createMockResponse();
    await handleGetCredential(req, res as any, stubActor, { id: 'round-trip' });

    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.id).toBe('round-trip');
    expect(body.type).toBe('api-key');
    expect(body.backend).toBe('cluster-local');
    expect(body.status).toBe('active');
    expect(body.updatedAt).toBeTruthy();
  });

  it('sets Content-Type to application/json', async () => {
    const req = {} as http.IncomingMessage;
    const res = createMockResponse();

    await handleGetCredential(req, res as any, stubActor, { id: 'x' });

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
  });
});

describe('integration: idempotency', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-idem-test-'));
    const agencyDir = path.join(tmpDir, '.agency');
    await fs.mkdir(agencyDir, { recursive: true });

    const backend = new ClusterLocalBackend({
      dataPath: path.join(tmpDir, 'credentials.dat'),
      keyPath: path.join(tmpDir, 'master.key'),
    });
    await backend.init();
    setCredentialBackend(backend);

    process.env['CREDHELPER_AGENCY_DIR'] = agencyDir;
  });

  afterEach(async () => {
    delete process.env['CREDHELPER_AGENCY_DIR'];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('PUT same ID twice overwrites cleanly', async () => {
    const req1 = createBodyReq({ type: 'api-key', value: 'v1' });
    const res1 = createMockResponse();
    await handlePutCredential(req1, res1 as any, stubActor, { id: 'idem' });
    expect(res1.writeHead).toHaveBeenCalledWith(200);

    const req2 = createBodyReq({ type: 'github-pat', value: 'v2' });
    const res2 = createMockResponse();
    await handlePutCredential(req2, res2 as any, stubActor, { id: 'idem' });
    expect(res2.writeHead).toHaveBeenCalledWith(200);

    // GET should return latest type
    const req = {} as http.IncomingMessage;
    const res = createMockResponse();
    await handleGetCredential(req, res as any, stubActor, { id: 'idem' });

    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.type).toBe('github-pat');
  });
});
