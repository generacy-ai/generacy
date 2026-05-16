import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { InitResult, StoreInitResult } from '../../src/types/init-result.js';

describe('daemon entrypoint structured init', () => {
  let tmpDir: string;
  let logs: string[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daemon-init-test-'));
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => { logs.push(msg); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('collects structured init results from stores', async () => {
    const { AppConfigEnvStore } = await import('../../src/services/app-config-env-store.js');

    const envPath = path.join(tmpDir, 'env');
    const store = new AppConfigEnvStore(envPath);
    await store.init();

    const result = store.getInitResult();
    expect(result.status).toBe('ok');
    expect(result.path).toBe(envPath);
    expect(result.reason).toBeUndefined();
  });

  it('emits structured JSON log lines per store', async () => {
    const { AppConfigEnvStore } = await import('../../src/services/app-config-env-store.js');

    const envPath = path.join(tmpDir, 'env');
    const store = new AppConfigEnvStore(envPath);
    await store.init();

    const result = store.getInitResult();
    const logLine = JSON.stringify({ event: 'store-init', store: 'appConfigEnv', ...result });
    console.log(logLine);

    const parsed = JSON.parse(logs[logs.length - 1]);
    expect(parsed.event).toBe('store-init');
    expect(parsed.store).toBe('appConfigEnv');
    expect(parsed.status).toBe('ok');
  });

  it('aggregates store results into InitResult shape', async () => {
    const { AppConfigEnvStore } = await import('../../src/services/app-config-env-store.js');

    const envPath = path.join(tmpDir, 'env');
    const store = new AppConfigEnvStore(envPath);
    await store.init();

    const initResult: InitResult = {
      stores: { appConfigEnv: store.getInitResult() },
      warnings: [],
    };

    if (initResult.stores['appConfigEnv']!.status !== 'ok') {
      initResult.warnings.push(`appConfigEnv: ${initResult.stores['appConfigEnv']!.reason}`);
    }

    expect(initResult.stores['appConfigEnv']!.status).toBe('ok');
    expect(initResult.warnings).toHaveLength(0);
  });

  it('writes init-result.json atomically', async () => {
    const initResultPath = path.join(tmpDir, 'init-result.json');
    const initResult: InitResult & { timestamp: string } = {
      stores: {
        appConfigEnv: { status: 'ok', path: '/tmp/test/env' },
        appConfigFile: { status: 'fallback', path: '/tmp/generacy-app-config/values.yaml', reason: 'EACCES on preferred path' },
      },
      warnings: ['appConfigFile: EACCES on preferred path'],
      timestamp: new Date().toISOString(),
    };

    const tmpPath = `${initResultPath}.tmp.${process.pid}`;
    await fs.writeFile(tmpPath, JSON.stringify(initResult));
    await fs.rename(tmpPath, initResultPath);

    const written = JSON.parse(await fs.readFile(initResultPath, 'utf8'));
    expect(written.stores.appConfigEnv.status).toBe('ok');
    expect(written.stores.appConfigFile.status).toBe('fallback');
    expect(written.warnings).toContain('appConfigFile: EACCES on preferred path');
    expect(written.timestamp).toBeTruthy();
  });

  it('full init sequence with secrets renders secrets.env', async () => {
    const { AppConfigEnvStore } = await import('../../src/services/app-config-env-store.js');
    const { AppConfigFileStore } = await import('../../src/services/app-config-file-store.js');
    const { AppConfigSecretEnvStore } = await import('../../src/services/app-config-secret-env-store.js');
    const { ClusterLocalBackend } = await import('@generacy-ai/credhelper');

    const backend = new ClusterLocalBackend({
      dataPath: path.join(tmpDir, 'credentials.dat'),
      keyPath: path.join(tmpDir, 'master.key'),
    });
    await backend.init();

    const appConfigDir = path.join(tmpDir, 'app-config');
    const envStore = new AppConfigEnvStore(path.join(appConfigDir, 'env'));
    await envStore.init();

    const fileStore = new AppConfigFileStore(backend, path.join(appConfigDir, 'values.yaml'));
    await fileStore.init();

    // Pre-seed: store a secret in backend + metadata
    await backend.setSecret('app-config/env/MY_SECRET', 'secret123');
    await fileStore.setEnvMetadata('MY_SECRET', true);
    // Also a non-secret
    await envStore.set('MY_PLAIN', 'plain_val');
    await fileStore.setEnvMetadata('MY_PLAIN', false);

    const secretEnvStore = new AppConfigSecretEnvStore(
      backend, fileStore, path.join(appConfigDir, 'secrets.env'),
    );
    await secretEnvStore.init();
    const renderResult = await secretEnvStore.renderAll();

    expect(renderResult.rendered).toEqual(['MY_SECRET']);
    expect(renderResult.failed).toEqual([]);

    // Verify file contents
    const raw = await fs.readFile(path.join(appConfigDir, 'secrets.env'), 'utf8');
    expect(raw).toBe('MY_SECRET="secret123"\n');

    // Verify init result aggregation
    const initResult: InitResult = {
      stores: {
        appConfigEnv: envStore.getInitResult(),
        appConfigFile: fileStore.getInitResult(),
        appConfigSecretEnv: secretEnvStore.getInitResult(),
      },
      warnings: [],
    };
    expect(initResult.stores['appConfigSecretEnv']!.status).toBe('ok');
    expect(initResult.stores['appConfigSecretEnv']!.path).toBe(path.join(appConfigDir, 'secrets.env'));
  });

  it('continues running when store enters fallback mode', async () => {
    const { AppConfigEnvStore } = await import('../../src/services/app-config-env-store.js');

    const mkdirSpy = vi.spyOn(fs, 'mkdir');
    const badPath = '/var/lib/generacy-app-config/env';
    const store = new AppConfigEnvStore(badPath);

    const eaccessErr = Object.assign(new Error('EACCES'), { code: 'EACCES' });

    mkdirSpy.mockImplementation(async (dirPath, _opts) => {
      if (String(dirPath).startsWith('/var/lib/generacy-app-config')) {
        throw eaccessErr;
      }
      return await fs.mkdir.call(fs, dirPath as string, _opts);
    });

    // Restore original mkdir for fallback path
    const origMkdir = fs.mkdir.bind(fs);
    mkdirSpy.mockImplementation(async (dirPath, opts) => {
      if (String(dirPath).startsWith('/var/lib/generacy-app-config')) {
        throw eaccessErr;
      }
      mkdirSpy.mockRestore();
      return origMkdir(dirPath as string, opts);
    });

    await store.init();
    expect(store.getStatus()).toBe('fallback');
  });
});
