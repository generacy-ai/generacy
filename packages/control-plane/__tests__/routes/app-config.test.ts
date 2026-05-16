import { Readable } from 'node:stream';
import type http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import type { ActorContext } from '../../src/context.js';
import {
  handleGetManifest,
  handleGetValues,
  handlePutEnv,
  handleDeleteEnv,
  handlePostFile,
  setAppConfigStores,
} from '../../src/routes/app-config.js';
import { AppConfigEnvStore } from '../../src/services/app-config-env-store.js';
import { AppConfigFileStore } from '../../src/services/app-config-file-store.js';
import { AppConfigSecretEnvStore } from '../../src/services/app-config-secret-env-store.js';
import { ClusterLocalBackend } from '@generacy-ai/credhelper';
import { setRelayPushEvent } from '../../src/relay-events.js';
import { resetGeneracyDirCache } from '../../src/services/project-dir-resolver.js';

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

function createEmptyReq(): http.IncomingMessage {
  const readable = new Readable({ read() {} });
  readable.push(null);
  return readable as unknown as http.IncomingMessage;
}

const stubActor: ActorContext = { userId: 'u-test', sessionId: 's-test' };

describe('app-config routes', () => {
  let tmpDir: string;
  let generacyDir: string;
  let backend: ClusterLocalBackend;
  let envStore: AppConfigEnvStore;
  let fileStore: AppConfigFileStore;
  let secretEnvStore: AppConfigSecretEnvStore;
  let relayEvents: Array<{ event: string; data: unknown }>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-config-test-'));
    generacyDir = path.join(tmpDir, '.generacy');
    await fs.mkdir(generacyDir, { recursive: true });

    const appConfigDir = path.join(tmpDir, 'app-config');
    await fs.mkdir(appConfigDir, { recursive: true });

    backend = new ClusterLocalBackend({
      dataPath: path.join(tmpDir, 'credentials.dat'),
      keyPath: path.join(tmpDir, 'master.key'),
    });
    await backend.init();

    envStore = new AppConfigEnvStore(path.join(appConfigDir, 'env'));
    await envStore.init();

    fileStore = new AppConfigFileStore(backend, path.join(appConfigDir, 'values.yaml'));
    await fileStore.init();

    secretEnvStore = new AppConfigSecretEnvStore(backend, fileStore, path.join(appConfigDir, 'secrets.env'));
    await secretEnvStore.init();

    setAppConfigStores(envStore, fileStore, backend, secretEnvStore);

    resetGeneracyDirCache();
    process.env['GENERACY_PROJECT_DIR'] = tmpDir;

    relayEvents = [];
    setRelayPushEvent((event, data) => {
      relayEvents.push({ event, data });
    });
  });

  afterEach(async () => {
    delete process.env['GENERACY_PROJECT_DIR'];
    setRelayPushEvent(undefined as any);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('GET /app-config/manifest', () => {
    it('returns null when no appConfig in cluster.yaml', async () => {
      await fs.writeFile(
        path.join(generacyDir, 'cluster.yaml'),
        YAML.stringify({ channel: 'stable', workers: 1 }),
      );

      const res = createMockResponse();
      await handleGetManifest(createEmptyReq(), res as any, stubActor, {});

      expect(res.writeHead).toHaveBeenCalledWith(200);
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body).toBeNull();
    });

    it('returns parsed appConfig when present', async () => {
      await fs.writeFile(
        path.join(generacyDir, 'cluster.yaml'),
        YAML.stringify({
          channel: 'stable',
          workers: 1,
          appConfig: {
            schemaVersion: '1',
            env: [{ name: 'TEST_VAR', secret: true }],
            files: [{ id: 'sa-key', mountPath: '/tmp/sa.json' }],
          },
        }),
      );

      const res = createMockResponse();
      await handleGetManifest(createEmptyReq(), res as any, stubActor, {});

      expect(res.writeHead).toHaveBeenCalledWith(200);
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body).toBeDefined();
      expect(body.env).toHaveLength(1);
      expect(body.env[0].name).toBe('TEST_VAR');
      expect(body.files).toHaveLength(1);
      expect(body.schemaVersion).toBe('1');
      // SC-001: no envelope wrapper — top-level keys are exactly the bare manifest shape
      expect(Object.keys(body).sort()).toEqual(['env', 'files', 'schemaVersion']);
    });

    it('returns null when cluster.yaml does not exist', async () => {
      const res = createMockResponse();
      await handleGetManifest(createEmptyReq(), res as any, stubActor, {});

      expect(res.writeHead).toHaveBeenCalledWith(200);
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body).toBeNull();
    });
  });

  describe('PUT /app-config/env', () => {
    it('sets a non-secret env var', async () => {
      const req = createBodyReq({ name: 'MY_VAR', value: 'hello', secret: false });
      const res = createMockResponse();

      await handlePutEnv(req, res as any, stubActor, {});

      expect(res.writeHead).toHaveBeenCalledWith(200);
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.accepted).toBe(true);
      expect(body.name).toBe('MY_VAR');
      expect(body.secret).toBe(false);

      // Verify env file has the value
      const stored = await envStore.get('MY_VAR');
      expect(stored).toBe('hello');
    });

    it('sets a secret env var in backend', async () => {
      const req = createBodyReq({ name: 'SECRET_KEY', value: 'sk-test', secret: true });
      const res = createMockResponse();

      await handlePutEnv(req, res as any, stubActor, {});

      expect(res.writeHead).toHaveBeenCalledWith(200);
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.accepted).toBe(true);
      expect(body.secret).toBe(true);

      // Verify it's in the backend, not the env file
      const envValue = await envStore.get('SECRET_KEY');
      expect(envValue).toBeUndefined();

      const backendValue = await backend.fetchSecret('app-config/env/SECRET_KEY');
      expect(backendValue).toBe('sk-test');
    });

    it('emits relay event', async () => {
      const req = createBodyReq({ name: 'TEST', value: 'val' });
      const res = createMockResponse();

      await handlePutEnv(req, res as any, stubActor, {});

      expect(relayEvents).toHaveLength(1);
      expect(relayEvents[0]!.event).toBe('cluster.app-config');
      expect((relayEvents[0]!.data as any).action).toBe('env-set');
    });

    it('returns 400 for invalid body', async () => {
      const req = createBodyReq({ name: '', value: 'val' });
      const res = createMockResponse();

      await handlePutEnv(req, res as any, stubActor, {});

      expect(res.writeHead).toHaveBeenCalledWith(400);
    });
  });

  describe('DELETE /app-config/env/:name', () => {
    it('deletes a non-secret env var', async () => {
      // Set first
      await envStore.set('TO_DELETE', 'value');
      await fileStore.setEnvMetadata('TO_DELETE', false);

      const res = createMockResponse();
      await handleDeleteEnv(createEmptyReq(), res as any, stubActor, { name: 'TO_DELETE' });

      expect(res.writeHead).toHaveBeenCalledWith(200);
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.accepted).toBe(true);

      const stored = await envStore.get('TO_DELETE');
      expect(stored).toBeUndefined();
    });

    it('returns 404 for non-existent var', async () => {
      const res = createMockResponse();
      await handleDeleteEnv(createEmptyReq(), res as any, stubActor, { name: 'MISSING' });

      expect(res.writeHead).toHaveBeenCalledWith(404);
    });

    it('emits relay event on delete', async () => {
      await envStore.set('DEL_TEST', 'val');
      await fileStore.setEnvMetadata('DEL_TEST', false);

      const res = createMockResponse();
      await handleDeleteEnv(createEmptyReq(), res as any, stubActor, { name: 'DEL_TEST' });

      expect(relayEvents).toHaveLength(1);
      expect((relayEvents[0]!.data as any).action).toBe('env-deleted');
    });
  });

  describe('POST /app-config/files/:id', () => {
    it('stores and writes file blob for a manifest-declared file', async () => {
      const mountPath = path.join(tmpDir, 'files', 'sa.json');
      await fs.writeFile(
        path.join(generacyDir, 'cluster.yaml'),
        YAML.stringify({
          appConfig: {
            schemaVersion: '1',
            files: [{ id: 'gcp-sa', mountPath }],
          },
        }),
      );

      const data = Buffer.from('{"type":"service_account"}').toString('base64');
      const req = createBodyReq({ data });
      const res = createMockResponse();

      await handlePostFile(req, res as any, stubActor, { id: 'gcp-sa' });

      expect(res.writeHead).toHaveBeenCalledWith(200);
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.accepted).toBe(true);
      expect(body.id).toBe('gcp-sa');

      // Verify file was written
      const content = await fs.readFile(mountPath, 'utf-8');
      expect(content).toBe('{"type":"service_account"}');
    });

    it('rejects undeclared file ID', async () => {
      await fs.writeFile(
        path.join(generacyDir, 'cluster.yaml'),
        YAML.stringify({
          appConfig: {
            schemaVersion: '1',
            files: [],
          },
        }),
      );

      const req = createBodyReq({ data: 'dGVzdA==' });
      const res = createMockResponse();

      await handlePostFile(req, res as any, stubActor, { id: 'unknown' });

      expect(res.writeHead).toHaveBeenCalledWith(400);
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.code).toBe('INVALID_REQUEST');
    });

    it('rejects denied mount path', async () => {
      await fs.writeFile(
        path.join(generacyDir, 'cluster.yaml'),
        YAML.stringify({
          appConfig: {
            schemaVersion: '1',
            files: [{ id: 'bad-file', mountPath: '/etc/passwd' }],
          },
        }),
      );

      const req = createBodyReq({ data: 'dGVzdA==' });
      const res = createMockResponse();

      await handlePostFile(req, res as any, stubActor, { id: 'bad-file' });

      expect(res.writeHead).toHaveBeenCalledWith(400);
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.error).toContain('restricted system directory');
    });

    it('emits relay event on file upload', async () => {
      const mountPath = path.join(tmpDir, 'files', 'test.txt');
      await fs.writeFile(
        path.join(generacyDir, 'cluster.yaml'),
        YAML.stringify({
          appConfig: {
            schemaVersion: '1',
            files: [{ id: 'test', mountPath }],
          },
        }),
      );

      const req = createBodyReq({ data: Buffer.from('data').toString('base64') });
      const res = createMockResponse();

      await handlePostFile(req, res as any, stubActor, { id: 'test' });

      expect(relayEvents).toHaveLength(1);
      expect((relayEvents[0]!.data as any).action).toBe('file-set');
    });
  });

  describe('PUT /app-config/env secret-flag transitions', () => {
    it('PUT with secret:true writes to backend + secrets.env', async () => {
      const req = createBodyReq({ name: 'SEC_VAR', value: 'secret_val', secret: true });
      const res = createMockResponse();
      await handlePutEnv(req, res as any, stubActor, {});

      expect(res.writeHead).toHaveBeenCalledWith(200);

      // In backend
      const backendVal = await backend.fetchSecret('app-config/env/SEC_VAR');
      expect(backendVal).toBe('secret_val');

      // In secrets.env
      const secretEntries = await secretEnvStore.list();
      expect(secretEntries.get('SEC_VAR')).toBe('secret_val');

      // NOT in plaintext env
      const envVal = await envStore.get('SEC_VAR');
      expect(envVal).toBeUndefined();
    });

    it('PUT with secret:false writes to plaintext env only (secrets.env unchanged)', async () => {
      // Pre-set a secret to ensure secrets.env has known content
      const reqSecret = createBodyReq({ name: 'EXISTING_SECRET', value: 'sec', secret: true });
      await handlePutEnv(reqSecret, createMockResponse() as any, stubActor, {});

      const secretsBefore = await secretEnvStore.list();

      // Now PUT a non-secret
      const req = createBodyReq({ name: 'PLAIN_VAR', value: 'plain_val', secret: false });
      const res = createMockResponse();
      await handlePutEnv(req, res as any, stubActor, {});

      expect(res.writeHead).toHaveBeenCalledWith(200);

      // In plaintext env
      const envVal = await envStore.get('PLAIN_VAR');
      expect(envVal).toBe('plain_val');

      // secrets.env content unchanged
      const secretsAfter = await secretEnvStore.list();
      expect(secretsAfter.size).toBe(secretsBefore.size);
      expect(secretsAfter.get('EXISTING_SECRET')).toBe('sec');
      expect(secretsAfter.has('PLAIN_VAR')).toBe(false);
    });

    it('transition true→false: cleans up backend + secrets.env, writes plaintext', async () => {
      // First set as secret
      const req1 = createBodyReq({ name: 'TRANS_VAR', value: 'v1', secret: true });
      await handlePutEnv(req1, createMockResponse() as any, stubActor, {});

      // Then change to non-secret
      const req2 = createBodyReq({ name: 'TRANS_VAR', value: 'v2', secret: false });
      const res = createMockResponse();
      await handlePutEnv(req2, res as any, stubActor, {});

      expect(res.writeHead).toHaveBeenCalledWith(200);

      // Now in plaintext
      const envVal = await envStore.get('TRANS_VAR');
      expect(envVal).toBe('v2');

      // Removed from secrets.env
      const secretEntries = await secretEnvStore.list();
      expect(secretEntries.has('TRANS_VAR')).toBe(false);

      // Removed from backend
      await expect(backend.fetchSecret('app-config/env/TRANS_VAR')).rejects.toThrow();
    });

    it('transition false→true: cleans up plaintext, writes backend + secrets.env', async () => {
      // First set as non-secret
      const req1 = createBodyReq({ name: 'TRANS_VAR2', value: 'v1', secret: false });
      await handlePutEnv(req1, createMockResponse() as any, stubActor, {});

      // Then change to secret
      const req2 = createBodyReq({ name: 'TRANS_VAR2', value: 'v2', secret: true });
      const res = createMockResponse();
      await handlePutEnv(req2, res as any, stubActor, {});

      expect(res.writeHead).toHaveBeenCalledWith(200);

      // In backend
      const backendVal = await backend.fetchSecret('app-config/env/TRANS_VAR2');
      expect(backendVal).toBe('v2');

      // In secrets.env
      const secretEntries = await secretEnvStore.list();
      expect(secretEntries.get('TRANS_VAR2')).toBe('v2');

      // Removed from plaintext
      const envVal = await envStore.get('TRANS_VAR2');
      expect(envVal).toBeUndefined();
    });

    it('DELETE of secret removes from both backend and secrets.env', async () => {
      // Set secret first
      const req = createBodyReq({ name: 'DEL_SECRET', value: 'sec', secret: true });
      await handlePutEnv(req, createMockResponse() as any, stubActor, {});

      // Delete it
      const res = createMockResponse();
      await handleDeleteEnv(createEmptyReq(), res as any, stubActor, { name: 'DEL_SECRET' });

      expect(res.writeHead).toHaveBeenCalledWith(200);

      // Gone from secrets.env
      const secretEntries = await secretEnvStore.list();
      expect(secretEntries.has('DEL_SECRET')).toBe(false);

      // Gone from backend
      await expect(backend.fetchSecret('app-config/env/DEL_SECRET')).rejects.toThrow();
    });
  });

  describe('GET /app-config/values', () => {
    it('returns empty when no values set', async () => {
      const res = createMockResponse();
      await handleGetValues(createEmptyReq(), res as any, stubActor, {});

      expect(res.writeHead).toHaveBeenCalledWith(200);
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.env).toEqual([]);
      expect(body.files).toEqual([]);
    });

    it('returns env entries with inManifest flag', async () => {
      await fs.writeFile(
        path.join(generacyDir, 'cluster.yaml'),
        YAML.stringify({
          appConfig: {
            schemaVersion: '1',
            env: [{ name: 'DECLARED_VAR' }],
          },
        }),
      );

      await envStore.set('DECLARED_VAR', 'val1');
      await fileStore.setEnvMetadata('DECLARED_VAR', false);
      await envStore.set('UNDECLARED_VAR', 'val2');
      await fileStore.setEnvMetadata('UNDECLARED_VAR', false);

      const res = createMockResponse();
      await handleGetValues(createEmptyReq(), res as any, stubActor, {});

      const body = JSON.parse(res.end.mock.calls[0][0]);
      const declared = body.env.find((e: any) => e.name === 'DECLARED_VAR');
      const undeclared = body.env.find((e: any) => e.name === 'UNDECLARED_VAR');

      expect(declared.inManifest).toBe(true);
      expect(undeclared.inManifest).toBe(false);
    });
  });
});
