import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AppConfigSecretEnvStore } from '../../src/services/app-config-secret-env-store.js';
import { AppConfigFileStore } from '../../src/services/app-config-file-store.js';
import { ClusterLocalBackend } from '@generacy-ai/credhelper';
import { StoreDisabledError } from '../../src/types/init-result.js';

describe('AppConfigSecretEnvStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'secret-env-store-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: create a real ClusterLocalBackend backed by tmpDir.
   */
  async function createBackend(): Promise<ClusterLocalBackend> {
    const backend = new ClusterLocalBackend({
      dataPath: path.join(tmpDir, 'credentials.dat'),
      keyPath: path.join(tmpDir, 'master.key'),
    });
    await backend.init();
    return backend;
  }

  /**
   * Helper: create a real AppConfigFileStore backed by tmpDir.
   */
  async function createFileStore(backend: ClusterLocalBackend): Promise<AppConfigFileStore> {
    const valuesPath = path.join(tmpDir, 'app-config', 'values.yaml');
    const store = new AppConfigFileStore(backend as never, valuesPath);
    await store.init();
    return store;
  }

  // ─── T003: Store basics ────────────────────────────────────────────

  describe('normal init', () => {
    let backend: ClusterLocalBackend;
    let fileStore: AppConfigFileStore;
    let store: AppConfigSecretEnvStore;

    beforeEach(async () => {
      backend = await createBackend();
      fileStore = await createFileStore(backend);
      const envPath = path.join(tmpDir, 'run', 'secrets.env');
      store = new AppConfigSecretEnvStore(backend, fileStore, envPath);
      await store.init();
    });

    it('reports ok status', () => {
      expect(store.getStatus()).toBe('ok');
    });

    it('returns init result with ok status and path', () => {
      const result = store.getInitResult();
      expect(result.status).toBe('ok');
      expect(result.path).toBe(path.join(tmpDir, 'run', 'secrets.env'));
      expect(result.reason).toBeUndefined();
    });

    it('set and list round-trip', async () => {
      await store.set('SECRET_A', 'alpha');
      await store.set('SECRET_B', 'bravo');

      const entries = await store.list();
      expect(entries.get('SECRET_A')).toBe('alpha');
      expect(entries.get('SECRET_B')).toBe('bravo');
      expect(entries.size).toBe(2);
    });

    it('delete removes an entry and returns true', async () => {
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

    it('set overwrites an existing key', async () => {
      await store.set('KEY', 'v1');
      await store.set('KEY', 'v2');

      const entries = await store.list();
      expect(entries.get('KEY')).toBe('v2');
      expect(entries.size).toBe(1);
    });

    it('atomic write format: KEY="value"\\n', async () => {
      await store.set('MY_KEY', 'my_value');

      const raw = await fs.readFile(path.join(tmpDir, 'run', 'secrets.env'), 'utf8');
      expect(raw).toBe('MY_KEY="my_value"\n');
    });

    it('escapes backslash in values', async () => {
      await store.set('BS', 'a\\b');

      const raw = await fs.readFile(path.join(tmpDir, 'run', 'secrets.env'), 'utf8');
      expect(raw).toBe('BS="a\\\\b"\n');

      // Round-trip preserves the original value
      const entries = await store.list();
      expect(entries.get('BS')).toBe('a\\b');
    });

    it('escapes double quotes in values', async () => {
      await store.set('DQ', 'say "hello"');

      const raw = await fs.readFile(path.join(tmpDir, 'run', 'secrets.env'), 'utf8');
      expect(raw).toBe('DQ="say \\"hello\\""\n');

      const entries = await store.list();
      expect(entries.get('DQ')).toBe('say "hello"');
    });

    it('escapes newlines in values', async () => {
      await store.set('NL', 'line1\nline2');

      const raw = await fs.readFile(path.join(tmpDir, 'run', 'secrets.env'), 'utf8');
      expect(raw).toBe('NL="line1\\nline2"\n');

      const entries = await store.list();
      expect(entries.get('NL')).toBe('line1\nline2');
    });

    it('escapes combined special characters', async () => {
      await store.set('COMBO', 'a\\b"c\nd');

      const raw = await fs.readFile(path.join(tmpDir, 'run', 'secrets.env'), 'utf8');
      expect(raw).toBe('COMBO="a\\\\b\\"c\\nd"\n');

      const entries = await store.list();
      expect(entries.get('COMBO')).toBe('a\\b"c\nd');
    });

    it('writes empty file when all entries deleted', async () => {
      await store.set('TEMP', 'val');
      await store.delete('TEMP');

      const raw = await fs.readFile(path.join(tmpDir, 'run', 'secrets.env'), 'utf8');
      expect(raw).toBe('');
    });
  });

  describe('fallback mode', () => {
    let backend: ClusterLocalBackend;
    let fileStore: AppConfigFileStore;
    let store: AppConfigSecretEnvStore;
    const fallbackDir = '/tmp/generacy-app-config';

    beforeEach(async () => {
      backend = await createBackend();
      fileStore = await createFileStore(backend);
      const preferredPath = path.join(tmpDir, 'no-access', 'secrets.env');
      store = new AppConfigSecretEnvStore(backend, fileStore, preferredPath);

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
      expect(result.path).toBe('/tmp/generacy-app-config/secrets.env');
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
    let backend: ClusterLocalBackend;
    let fileStore: AppConfigFileStore;
    let store: AppConfigSecretEnvStore;

    beforeEach(async () => {
      backend = await createBackend();
      fileStore = await createFileStore(backend);
      const preferredPath = path.join(tmpDir, 'no-access', 'secrets.env');
      store = new AppConfigSecretEnvStore(backend, fileStore, preferredPath);

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

  // ─── T004: renderAll() ─────────────────────────────────────────────

  describe('renderAll()', () => {
    let backend: ClusterLocalBackend;
    let fileStore: AppConfigFileStore;
    let store: AppConfigSecretEnvStore;
    let envPath: string;

    beforeEach(async () => {
      backend = await createBackend();
      fileStore = await createFileStore(backend);
      envPath = path.join(tmpDir, 'run', 'secrets.env');
      store = new AppConfigSecretEnvStore(backend, fileStore, envPath);
      await store.init();
    });

    it('renders only secret:true entries to file', async () => {
      // Set up metadata: one secret, one non-secret
      await fileStore.setEnvMetadata('SECRET_VAR', true);
      await fileStore.setEnvMetadata('PLAIN_VAR', false);

      // Store the secret value in the backend
      await backend.setSecret('app-config/env/SECRET_VAR', 'secret_value');

      const result = await store.renderAll();

      expect(result.rendered).toEqual(['SECRET_VAR']);
      expect(result.failed).toEqual([]);

      // Verify file contents — only the secret entry should be present
      const raw = await fs.readFile(envPath, 'utf8');
      expect(raw).toBe('SECRET_VAR="secret_value"\n');
      expect(raw).not.toContain('PLAIN_VAR');
    });

    it('non-secret entries are NOT in the file', async () => {
      await fileStore.setEnvMetadata('ONLY_PLAIN', false);

      const result = await store.renderAll();

      expect(result.rendered).toEqual([]);
      expect(result.failed).toEqual([]);

      const raw = await fs.readFile(envPath, 'utf8');
      expect(raw).toBe('');
      expect(raw).not.toContain('ONLY_PLAIN');
    });

    it('partial render on unseal failure: one succeeds, one throws', async () => {
      await fileStore.setEnvMetadata('GOOD_SECRET', true);
      await fileStore.setEnvMetadata('BAD_SECRET', true);

      // Only store the good secret in the backend
      await backend.setSecret('app-config/env/GOOD_SECRET', 'good_value');
      // BAD_SECRET is not stored, so fetchSecret will throw

      // Suppress console.warn noise from the expected failure
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await store.renderAll();

      expect(result.rendered).toContain('GOOD_SECRET');
      expect(result.failed).toContain('BAD_SECRET');
      expect(result.rendered).toHaveLength(1);
      expect(result.failed).toHaveLength(1);

      // File should contain only the good secret
      const raw = await fs.readFile(envPath, 'utf8');
      expect(raw).toContain('GOOD_SECRET="good_value"');
      expect(raw).not.toContain('BAD_SECRET');
    });

    it('RenderResult shape is { rendered: string[], failed: string[] }', async () => {
      await fileStore.setEnvMetadata('S1', true);
      await backend.setSecret('app-config/env/S1', 'v1');

      const result = await store.renderAll();

      expect(result).toHaveProperty('rendered');
      expect(result).toHaveProperty('failed');
      expect(Array.isArray(result.rendered)).toBe(true);
      expect(Array.isArray(result.failed)).toBe(true);
    });

    it('returns empty arrays and writes empty file when no secrets exist', async () => {
      // No metadata at all
      const result = await store.renderAll();

      expect(result.rendered).toEqual([]);
      expect(result.failed).toEqual([]);

      const raw = await fs.readFile(envPath, 'utf8');
      expect(raw).toBe('');
    });

    it('returns empty arrays when only non-secret entries exist', async () => {
      await fileStore.setEnvMetadata('PLAIN_A', false);
      await fileStore.setEnvMetadata('PLAIN_B', false);

      const result = await store.renderAll();

      expect(result.rendered).toEqual([]);
      expect(result.failed).toEqual([]);

      const raw = await fs.readFile(envPath, 'utf8');
      expect(raw).toBe('');
    });

    it('handles fetchSecret throwing for all secrets gracefully', async () => {
      await fileStore.setEnvMetadata('FAIL_1', true);
      await fileStore.setEnvMetadata('FAIL_2', true);

      // Neither secret stored in backend — both will throw
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await store.renderAll();

      expect(result.rendered).toEqual([]);
      expect(result.failed).toContain('FAIL_1');
      expect(result.failed).toContain('FAIL_2');
      expect(result.failed).toHaveLength(2);

      const raw = await fs.readFile(envPath, 'utf8');
      expect(raw).toBe('');
    });

    it('uses vi.spyOn to force fetchSecret failure for specific keys', async () => {
      await fileStore.setEnvMetadata('SPY_OK', true);
      await fileStore.setEnvMetadata('SPY_FAIL', true);

      // Store both secrets in the backend
      await backend.setSecret('app-config/env/SPY_OK', 'ok_value');
      await backend.setSecret('app-config/env/SPY_FAIL', 'fail_value');

      // Now spy on fetchSecret to make one specific key fail
      const originalFetchSecret = backend.fetchSecret.bind(backend);
      vi.spyOn(backend, 'fetchSecret').mockImplementation(async (key: string) => {
        if (key === 'app-config/env/SPY_FAIL') {
          throw new Error('simulated unseal failure');
        }
        return originalFetchSecret(key);
      });

      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await store.renderAll();

      expect(result.rendered).toContain('SPY_OK');
      expect(result.failed).toContain('SPY_FAIL');

      const raw = await fs.readFile(envPath, 'utf8');
      expect(raw).toContain('SPY_OK="ok_value"');
      expect(raw).not.toContain('SPY_FAIL');
    });

    it('renders multiple secrets correctly', async () => {
      await fileStore.setEnvMetadata('DB_PASSWORD', true);
      await fileStore.setEnvMetadata('API_TOKEN', true);
      await fileStore.setEnvMetadata('NON_SECRET', false);

      await backend.setSecret('app-config/env/DB_PASSWORD', 'hunter2');
      await backend.setSecret('app-config/env/API_TOKEN', 'tok_abc123');

      const result = await store.renderAll();

      expect(result.rendered.sort()).toEqual(['API_TOKEN', 'DB_PASSWORD']);
      expect(result.failed).toEqual([]);

      const raw = await fs.readFile(envPath, 'utf8');
      expect(raw).toContain('DB_PASSWORD="hunter2"');
      expect(raw).toContain('API_TOKEN="tok_abc123"');
      expect(raw).not.toContain('NON_SECRET');
    });

    it('returns empty arrays in disabled mode without writing', async () => {
      // Create a new store that will be disabled
      const disabledEnvPath = path.join(tmpDir, 'disabled', 'secrets.env');
      const disabledStore = new AppConfigSecretEnvStore(backend, fileStore, disabledEnvPath);

      vi.spyOn(fs, 'mkdir').mockImplementation(async () => {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });

      await disabledStore.init();
      expect(disabledStore.getStatus()).toBe('disabled');

      // Add metadata with secrets
      vi.restoreAllMocks();
      await fileStore.setEnvMetadata('DISABLED_SECRET', true);
      await backend.setSecret('app-config/env/DISABLED_SECRET', 'value');

      const result = await disabledStore.renderAll();

      expect(result.rendered).toEqual([]);
      expect(result.failed).toEqual([]);
    });
  });
});
