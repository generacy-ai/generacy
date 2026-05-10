import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ClusterLocalBackend } from '../cluster-local-backend.js';

describe('ClusterLocalBackend', () => {
  let tmpDir: string;
  let backend: ClusterLocalBackend;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-test-'));
    backend = new ClusterLocalBackend({
      dataPath: path.join(tmpDir, 'credentials.dat'),
      keyPath: path.join(tmpDir, 'master.key'),
    });
    await backend.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('setSecret and fetchSecret round-trip', async () => {
    await backend.setSecret('my-key', 'my-value');
    const value = await backend.fetchSecret('my-key');
    expect(value).toBe('my-value');
  });

  it('fetchSecret throws for missing key', async () => {
    await expect(backend.fetchSecret('nonexistent')).rejects.toThrow('not found');
  });

  it('setSecret overwrites idempotently', async () => {
    await backend.setSecret('key', 'value1');
    await backend.setSecret('key', 'value2');
    const value = await backend.fetchSecret('key');
    expect(value).toBe('value2');
  });

  it('deleteSecret removes the key', async () => {
    await backend.setSecret('key', 'value');
    await backend.deleteSecret('key');
    await expect(backend.fetchSecret('key')).rejects.toThrow('not found');
  });

  it('deleteSecret throws for missing key', async () => {
    await expect(backend.deleteSecret('nonexistent')).rejects.toThrow('not found');
  });

  it('persists across new backend instances', async () => {
    await backend.setSecret('persist-key', 'persist-value');

    const backend2 = new ClusterLocalBackend({
      dataPath: path.join(tmpDir, 'credentials.dat'),
      keyPath: path.join(tmpDir, 'master.key'),
    });
    await backend2.init();

    const value = await backend2.fetchSecret('persist-key');
    expect(value).toBe('persist-value');
  });
});
