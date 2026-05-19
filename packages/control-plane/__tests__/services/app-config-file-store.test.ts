import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AppConfigFileStore } from '../../src/services/app-config-file-store.js';
import { StoreDisabledError } from '../../src/types/init-result.js';
import { ClusterLocalBackend } from '@generacy-ai/credhelper';
import type { AppConfig } from '../../src/schemas.js';

function createMockBackend() {
  return {
    init: vi.fn(),
    fetchSecret: vi.fn(),
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
  };
}

describe('AppConfigFileStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acfs-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('normal init', () => {
    it('returns status "ok" when preferred path is writable', async () => {
      const valuesPath = path.join(tmpDir, 'app-config', 'values.yaml');
      const backend = createMockBackend();
      const store = new AppConfigFileStore(backend as never, valuesPath);

      await store.init();

      expect(store.getStatus()).toBe('ok');
    });

    it('getInitResult includes path and no reason on success', async () => {
      const valuesPath = path.join(tmpDir, 'app-config', 'values.yaml');
      const backend = createMockBackend();
      const store = new AppConfigFileStore(backend as never, valuesPath);

      await store.init();

      const result = store.getInitResult();
      expect(result.status).toBe('ok');
      expect(result.path).toBe(valuesPath);
      expect(result.reason).toBeUndefined();
    });

    it('getMetadata returns empty shape when no metadata file exists yet', async () => {
      const valuesPath = path.join(tmpDir, 'app-config', 'values.yaml');
      const backend = createMockBackend();
      const store = new AppConfigFileStore(backend as never, valuesPath);

      await store.init();

      const meta = await store.getMetadata();
      expect(meta).toEqual({ env: {}, files: {} });
    });
  });

  describe('fallback mode', () => {
    it('falls back to /tmp path when preferred path throws EACCES', async () => {
      const backend = createMockBackend();
      // Use the default path (which is /var/lib/generacy-app-config/values.yaml)
      // so the fallback goes to /tmp/generacy-app-config/values.yaml
      const store = new AppConfigFileStore(backend as never);

      const mkdirSpy = vi.spyOn(fs, 'mkdir');
      let callCount = 0;
      mkdirSpy.mockImplementation(async (dirPath, _options?) => {
        callCount++;
        if (callCount === 1) {
          // First call: preferred path fails with EACCES
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        // Second call: fallback path succeeds — actually create the dir
        return undefined;
      });

      await store.init();

      expect(store.getStatus()).toBe('fallback');
      expect(mkdirSpy).toHaveBeenCalledTimes(2);
    });

    it('getInitResult reports fallback status with reason', async () => {
      const backend = createMockBackend();
      const store = new AppConfigFileStore(backend as never);

      const mkdirSpy = vi.spyOn(fs, 'mkdir');
      let callCount = 0;
      mkdirSpy.mockImplementation(async (_dirPath, _options?) => {
        callCount++;
        if (callCount === 1) {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return undefined;
      });

      await store.init();

      const result = store.getInitResult();
      expect(result.status).toBe('fallback');
      expect(result.path).toBe('/tmp/generacy-app-config/values.yaml');
      expect(result.reason).toContain('EACCES');
      expect(result.reason).toContain('/tmp/generacy-app-config/values.yaml');
    });

    it('getMetadata still works in fallback mode', async () => {
      const backend = createMockBackend();
      const store = new AppConfigFileStore(backend as never);

      const mkdirSpy = vi.spyOn(fs, 'mkdir');
      let callCount = 0;
      mkdirSpy.mockImplementation(async (_dirPath, _options?) => {
        callCount++;
        if (callCount === 1) {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return undefined;
      });

      await store.init();

      // getMetadata should not throw; values file doesn't exist yet so returns empty
      const meta = await store.getMetadata();
      expect(meta).toEqual({ env: {}, files: {} });
    });
  });

  describe('disabled mode', () => {
    it('returns status "disabled" when both paths fail with EACCES', async () => {
      const backend = createMockBackend();
      const store = new AppConfigFileStore(backend as never);

      const mkdirSpy = vi.spyOn(fs, 'mkdir');
      mkdirSpy.mockImplementation(async (_dirPath, _options?) => {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });

      await store.init();

      expect(store.getStatus()).toBe('disabled');
    });

    it('getInitResult reports disabled status with reason mentioning both paths', async () => {
      const backend = createMockBackend();
      const store = new AppConfigFileStore(backend as never);

      const mkdirSpy = vi.spyOn(fs, 'mkdir');
      mkdirSpy.mockImplementation(async (_dirPath, _options?) => {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });

      await store.init();

      const result = store.getInitResult();
      expect(result.status).toBe('disabled');
      expect(result.path).toBeUndefined();
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain('EACCES');
    });

    it('getMetadata returns empty shape when disabled', async () => {
      const backend = createMockBackend();
      const store = new AppConfigFileStore(backend as never);

      const mkdirSpy = vi.spyOn(fs, 'mkdir');
      mkdirSpy.mockImplementation(async (_dirPath, _options?) => {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });

      await store.init();

      const meta = await store.getMetadata();
      expect(meta).toEqual({ env: {}, files: {} });
    });

    it('setFile throws StoreDisabledError when disabled', async () => {
      const backend = createMockBackend();
      const store = new AppConfigFileStore(backend as never);

      const mkdirSpy = vi.spyOn(fs, 'mkdir');
      mkdirSpy.mockImplementation(async (_dirPath, _options?) => {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });

      await store.init();

      await expect(
        store.setFile('test-id', '/tmp/test-mount/file.txt', Buffer.from('data')),
      ).rejects.toThrow(StoreDisabledError);
    });

    it('setEnvMetadata throws StoreDisabledError when disabled', async () => {
      const backend = createMockBackend();
      const store = new AppConfigFileStore(backend as never);

      const mkdirSpy = vi.spyOn(fs, 'mkdir');
      mkdirSpy.mockImplementation(async (_dirPath, _options?) => {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });

      await store.init();

      await expect(store.setEnvMetadata('MY_VAR', false)).rejects.toThrow(StoreDisabledError);
    });

    it('StoreDisabledError has correct code', async () => {
      const backend = createMockBackend();
      const store = new AppConfigFileStore(backend as never);

      const mkdirSpy = vi.spyOn(fs, 'mkdir');
      mkdirSpy.mockImplementation(async (_dirPath, _options?) => {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });

      await store.init();

      try {
        await store.setFile('test-id', '/tmp/test-mount/file.txt', Buffer.from('data'));
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StoreDisabledError);
        expect((err as StoreDisabledError).code).toBe('app-config-store-disabled');
      }
    });
  });

  describe('non-permission errors propagate', () => {
    it('rethrows non-permission errors from preferred path', async () => {
      const backend = createMockBackend();
      const store = new AppConfigFileStore(backend as never);

      const mkdirSpy = vi.spyOn(fs, 'mkdir');
      mkdirSpy.mockImplementation(async (_dirPath, _options?) => {
        const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
        err.code = 'ENOSPC';
        throw err;
      });

      await expect(store.init()).rejects.toThrow('ENOSPC');
    });

    it('rethrows non-permission errors from fallback path', async () => {
      const backend = createMockBackend();
      const store = new AppConfigFileStore(backend as never);

      const mkdirSpy = vi.spyOn(fs, 'mkdir');
      let callCount = 0;
      mkdirSpy.mockImplementation(async (_dirPath, _options?) => {
        callCount++;
        if (callCount === 1) {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
        err.code = 'ENOSPC';
        throw err;
      });

      await expect(store.init()).rejects.toThrow('ENOSPC');
    });
  });

  // ─── renderAll() ─────────────────────────────────────────────────

  describe('renderAll()', () => {
    let backend: ClusterLocalBackend;
    let store: AppConfigFileStore;
    let mountDir: string;

    async function createRealBackend(): Promise<ClusterLocalBackend> {
      const b = new ClusterLocalBackend({
        dataPath: path.join(tmpDir, 'credentials.dat'),
        keyPath: path.join(tmpDir, 'master.key'),
      });
      await b.init();
      return b;
    }

    beforeEach(async () => {
      backend = await createRealBackend();
      const valuesPath = path.join(tmpDir, 'app-config', 'values.yaml');
      store = new AppConfigFileStore(backend as never, valuesPath);
      await store.init();
      mountDir = path.join(tmpDir, 'mounts');
      await fs.mkdir(mountDir, { recursive: true });
    });

    // T007: happy path
    it('renders uploaded files to their mountPath', async () => {
      const mountPath = path.join(mountDir, 'sa.json');
      const fileData = Buffer.from('{"type":"service_account"}');
      await store.setFile('gcp-sa', mountPath, fileData);

      // Delete the file at mountPath to simulate container recreate
      await fs.rm(mountPath);

      const manifest: AppConfig = {
        schemaVersion: '1',
        env: [],
        files: [{ id: 'gcp-sa', mountPath, required: true }],
      };

      const result = await store.renderAll(async () => manifest);

      expect(result.rendered).toEqual(['gcp-sa']);
      expect(result.failed).toEqual([]);

      const written = await fs.readFile(mountPath);
      expect(written).toEqual(fileData);
    });

    // T008: denylisted mountPath skipped
    it('skips files with denylisted mountPath', async () => {
      const safeMountPath = path.join(mountDir, 'temp.json');
      await store.setFile('denied-file', safeMountPath, Buffer.from('data'));

      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const manifest: AppConfig = {
        schemaVersion: '1',
        env: [],
        files: [{ id: 'denied-file', mountPath: '/etc/foo', required: true }],
      };

      const result = await store.renderAll(async () => manifest);

      expect(result.rendered).toEqual([]);
      expect(result.failed).toEqual(['denied-file']);
    });

    // T009: missing blob in backend
    it('skips files when backend fetchSecret throws', async () => {
      const mountPath = path.join(mountDir, 'missing.json');
      await store.setFile('blob-missing', mountPath, Buffer.from('data'));

      // Delete the blob from backend to simulate missing data
      await backend.deleteSecret('app-config/file/blob-missing');

      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const manifest: AppConfig = {
        schemaVersion: '1',
        env: [],
        files: [{ id: 'blob-missing', mountPath, required: true }],
      };

      const result = await store.renderAll(async () => manifest);

      expect(result.rendered).toEqual([]);
      expect(result.failed).toEqual(['blob-missing']);
    });

    // T010: orphaned file (id not in manifest)
    it('skips orphaned files not in manifest', async () => {
      const mountPath = path.join(mountDir, 'orphan.json');
      await store.setFile('orphan-id', mountPath, Buffer.from('data'));

      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Manifest has no files
      const manifest: AppConfig = {
        schemaVersion: '1',
        env: [],
        files: [],
      };

      const result = await store.renderAll(async () => manifest);

      expect(result.rendered).toEqual([]);
      expect(result.failed).toEqual(['orphan-id']);
    });

    // T011: disabled store returns empty immediately
    it('returns empty result when store is disabled', async () => {
      const disabledBackend = createMockBackend();
      const disabledStore = new AppConfigFileStore(disabledBackend as never);

      vi.spyOn(fs, 'mkdir').mockImplementation(async () => {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });

      await disabledStore.init();
      expect(disabledStore.getStatus()).toBe('disabled');

      vi.restoreAllMocks();

      const result = await disabledStore.renderAll(async () => ({
        schemaVersion: '1' as const,
        env: [],
        files: [{ id: 'x', mountPath: '/tmp/x', required: true }],
      }));

      expect(result.rendered).toEqual([]);
      expect(result.failed).toEqual([]);
    });

    // T012: setFile still works after atomicWriteFile extraction
    it('setFile writes file correctly after atomicWriteFile refactor', async () => {
      const mountPath = path.join(mountDir, 'refactor-test.txt');
      const data = Buffer.from('refactor-test-content');

      await store.setFile('refactor-id', mountPath, data);

      const written = await fs.readFile(mountPath);
      expect(written).toEqual(data);

      const meta = await store.getMetadata();
      expect(meta.files['refactor-id']).toBeDefined();
      expect(meta.files['refactor-id'].size).toBe(data.length);
    });
  });
});
