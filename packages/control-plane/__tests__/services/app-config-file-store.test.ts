import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AppConfigFileStore } from '../../src/services/app-config-file-store.js';
import { StoreDisabledError } from '../../src/types/init-result.js';

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
});
