import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ClusterLocalBackend } from '../../src/backends/cluster-local-backend.js';
import { CredhelperError } from '../../src/errors.js';

describe('ClusterLocalBackend', () => {
  let tmpDir: string;
  let backend: ClusterLocalBackend;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'credhelper-backend-test-'));
    backend = new ClusterLocalBackend({
      dataPath: path.join(tmpDir, 'credentials.dat'),
      keyPath: path.join(tmpDir, 'master.key'),
    });
    await backend.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('full CRUD roundtrip: set, get, delete', async () => {
    await backend.setSecret('github-pat', 'ghp_abc123');
    const value = await backend.fetchSecret('github-pat');
    expect(value).toBe('ghp_abc123');

    await backend.deleteSecret('github-pat');
    try {
      await backend.fetchSecret('github-pat');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CredhelperError);
      expect((err as CredhelperError).code).toBe('BACKEND_SECRET_NOT_FOUND');
    }
  });

  it('fetchSecret for missing key throws BACKEND_SECRET_NOT_FOUND', async () => {
    try {
      await backend.fetchSecret('nonexistent');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CredhelperError);
      expect((err as CredhelperError).code).toBe('BACKEND_SECRET_NOT_FOUND');
    }
  });

  it('overwrite existing credential', async () => {
    await backend.setSecret('key1', 'value1');
    await backend.setSecret('key1', 'value2');
    const value = await backend.fetchSecret('key1');
    expect(value).toBe('value2');
  });

  it('delete non-existent key throws BACKEND_SECRET_NOT_FOUND', async () => {
    try {
      await backend.deleteSecret('missing');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CredhelperError);
      expect((err as CredhelperError).code).toBe('BACKEND_SECRET_NOT_FOUND');
    }
  });

  it('init with empty store succeeds', async () => {
    const fresh = new ClusterLocalBackend({
      dataPath: path.join(tmpDir, 'empty-credentials.dat'),
      keyPath: path.join(tmpDir, 'master.key'),
    });
    await fresh.init();
    // Should not throw — empty store is valid
  });

  it('init with corrupt file fails closed', async () => {
    const corruptPath = path.join(tmpDir, 'corrupt-credentials.dat');
    await fs.writeFile(corruptPath, 'not valid json');
    const corrupt = new ClusterLocalBackend({
      dataPath: corruptPath,
      keyPath: path.join(tmpDir, 'master.key'),
    });
    try {
      await corrupt.init();
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CredhelperError);
      expect((err as CredhelperError).code).toBe('CREDENTIAL_STORE_CORRUPT');
    }
  });

  it('volume-snapshot scenario: credentials without master key cannot decrypt', async () => {
    await backend.setSecret('secret-key', 'secret-value');

    // Copy credentials.dat to new location but use a different master key
    const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'credhelper-snapshot-'));
    try {
      await fs.copyFile(
        path.join(tmpDir, 'credentials.dat'),
        path.join(snapshotDir, 'credentials.dat'),
      );
      // Don't copy master.key — a new one will be generated
      const snapshot = new ClusterLocalBackend({
        dataPath: path.join(snapshotDir, 'credentials.dat'),
        keyPath: path.join(snapshotDir, 'master.key'),
      });
      await snapshot.init();
      // Attempting to decrypt with wrong key should fail
      expect(() => snapshot.fetchSecret('secret-key')).rejects.toThrow();
    } finally {
      await fs.rm(snapshotDir, { recursive: true, force: true });
    }
  });
});
