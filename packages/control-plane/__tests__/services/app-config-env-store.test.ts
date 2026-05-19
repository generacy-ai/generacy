import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AppConfigEnvStore } from '../../src/services/app-config-env-store.js';
import { StoreDisabledError } from '../../src/types/init-result.js';

describe('AppConfigEnvStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'env-store-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('normal init', () => {
    let store: AppConfigEnvStore;

    beforeEach(async () => {
      const envPath = path.join(tmpDir, 'app-config', 'env');
      store = new AppConfigEnvStore(envPath);
      await store.init();
    });

    it('reports ok status', () => {
      expect(store.getStatus()).toBe('ok');
    });

    it('returns init result with ok status and path', () => {
      const result = store.getInitResult();
      expect(result.status).toBe('ok');
      expect(result.path).toBe(path.join(tmpDir, 'app-config', 'env'));
      expect(result.reason).toBeUndefined();
    });

    it('set and list round-trip', async () => {
      await store.set('FOO', 'bar');
      await store.set('BAZ', 'qux');

      const entries = await store.list();
      expect(entries.get('FOO')).toBe('bar');
      expect(entries.get('BAZ')).toBe('qux');
      expect(entries.size).toBe(2);
    });

    it('delete removes an entry', async () => {
      await store.set('TO_DELETE', 'value');
      const existed = await store.delete('TO_DELETE');
      expect(existed).toBe(true);

      const entries = await store.list();
      expect(entries.has('TO_DELETE')).toBe(false);
    });

    it('delete returns false for non-existent key', async () => {
      const existed = await store.delete('MISSING');
      expect(existed).toBe(false);
    });
  });

  describe('fallback mode', () => {
    let store: AppConfigEnvStore;
    const fallbackDir = '/tmp/generacy-app-config';

    beforeEach(async () => {
      const preferredPath = path.join(tmpDir, 'no-access', 'env');
      store = new AppConfigEnvStore(preferredPath);

      const originalMkdir = fs.mkdir.bind(fs);
      vi.spyOn(fs, 'mkdir').mockImplementation(async (dirPath: any, options?: any) => {
        if (String(dirPath).startsWith(path.join(tmpDir, 'no-access'))) {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return originalMkdir(dirPath, options);
      });

      await store.init();
    });

    afterEach(async () => {
      await fs.rm(fallbackDir, { recursive: true, force: true }).catch(() => {});
    });

    it('reports fallback status', () => {
      expect(store.getStatus()).toBe('fallback');
    });

    it('returns init result with fallback status and fallback path', () => {
      const result = store.getInitResult();
      expect(result.status).toBe('fallback');
      expect(result.path).toBe('/tmp/generacy-app-config/env');
      expect(result.reason).toContain('EACCES');
    });

    it('set and list work on the fallback path', async () => {
      await store.set('FALLBACK_KEY', 'fallback_value');

      const entries = await store.list();
      expect(entries.get('FALLBACK_KEY')).toBe('fallback_value');
    });

    it('delete works on the fallback path', async () => {
      await store.set('FB_DEL', 'val');
      const existed = await store.delete('FB_DEL');
      expect(existed).toBe(true);

      const entries = await store.list();
      expect(entries.has('FB_DEL')).toBe(false);
    });
  });

  describe('disabled mode', () => {
    let store: AppConfigEnvStore;

    beforeEach(async () => {
      const preferredPath = path.join(tmpDir, 'no-access', 'env');
      store = new AppConfigEnvStore(preferredPath);

      vi.spyOn(fs, 'mkdir').mockImplementation(async () => {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });

      await store.init();
    });

    it('reports disabled status', () => {
      expect(store.getStatus()).toBe('disabled');
    });

    it('returns init result with disabled status and no path', () => {
      const result = store.getInitResult();
      expect(result.status).toBe('disabled');
      expect(result.path).toBeUndefined();
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain('failed');
    });

    it('list returns an empty Map', async () => {
      const entries = await store.list();
      expect(entries).toBeInstanceOf(Map);
      expect(entries.size).toBe(0);
    });

    it('set throws StoreDisabledError', async () => {
      await expect(store.set('KEY', 'value')).rejects.toThrow(StoreDisabledError);
    });

    it('delete throws StoreDisabledError', async () => {
      await expect(store.delete('KEY')).rejects.toThrow(StoreDisabledError);
    });

    it('thrown StoreDisabledError has correct code', async () => {
      try {
        await store.set('KEY', 'value');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StoreDisabledError);
        expect((err as StoreDisabledError).code).toBe('app-config-store-disabled');
      }
    });
  });
});
