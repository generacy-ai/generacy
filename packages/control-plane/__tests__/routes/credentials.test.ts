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
import { writeWizardEnvFile } from '../../src/services/wizard-env-writer.js';
import { refreshGhAuth } from '../../src/services/gh-auth-refresh.js';

vi.mock('../../src/services/wizard-env-writer.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/services/wizard-env-writer.js')>();
  return { ...original, writeWizardEnvFile: vi.fn().mockResolvedValue({ written: [], failed: [] }) };
});
vi.mock('../../src/services/gh-auth-refresh.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/services/gh-auth-refresh.js')>();
  return { ...original, refreshGhAuth: vi.fn().mockResolvedValue({ ok: true }) };
});

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

describe('handlePutCredential post-write refresh', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-refresh-test-'));
    const agencyDir = path.join(tmpDir, '.agency');
    await fs.mkdir(agencyDir, { recursive: true });

    const backend = new ClusterLocalBackend({
      dataPath: path.join(tmpDir, 'credentials.dat'),
      keyPath: path.join(tmpDir, 'master.key'),
    });
    await backend.init();
    setCredentialBackend(backend);

    process.env['CREDHELPER_AGENCY_DIR'] = agencyDir;

    vi.mocked(writeWizardEnvFile).mockClear();
    vi.mocked(refreshGhAuth).mockClear();
  });

  afterEach(async () => {
    delete process.env['CREDHELPER_AGENCY_DIR'];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('github-app triggers writeWizardEnvFile and refreshGhAuth with extracted token', async () => {
    const req = createBodyReq({ type: 'github-app', value: '{"installationId":1,"token":"ghs_fresh"}' });
    const res = createMockResponse();

    await handlePutCredential(req, res as any, stubActor, { id: 'gh-app-1' });

    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toEqual({ ok: true });

    expect(vi.mocked(writeWizardEnvFile)).toHaveBeenCalledWith({
      agencyDir: path.join(tmpDir, '.agency'),
    });
    expect(vi.mocked(refreshGhAuth)).toHaveBeenCalledWith('ghs_fresh');
  });

  it('github-pat triggers writeWizardEnvFile and refreshGhAuth with raw token', async () => {
    const req = createBodyReq({ type: 'github-pat', value: 'ghp_rawtoken' });
    const res = createMockResponse();

    await handlePutCredential(req, res as any, stubActor, { id: 'gh-pat-1' });

    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toEqual({ ok: true });

    expect(vi.mocked(writeWizardEnvFile)).toHaveBeenCalledWith({
      agencyDir: path.join(tmpDir, '.agency'),
    });
    expect(vi.mocked(refreshGhAuth)).toHaveBeenCalledWith('ghp_rawtoken');
  });

  it('api-key does not trigger writeWizardEnvFile or refreshGhAuth', async () => {
    const req = createBodyReq({ type: 'api-key', value: 'sk-test' });
    const res = createMockResponse();

    await handlePutCredential(req, res as any, stubActor, { id: 'api-1' });

    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toEqual({ ok: true });

    expect(vi.mocked(writeWizardEnvFile)).not.toHaveBeenCalled();
    expect(vi.mocked(refreshGhAuth)).not.toHaveBeenCalled();
  });
});
