import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { ClusterLocalBackend } from '@generacy-ai/credhelper';
import { writeCredential, setCredentialBackend } from '../../src/services/credential-writer.js';
import { setRelayPushEvent } from '../../src/relay-events.js';

describe('writeCredential', () => {
  let tmpDir: string;
  let agencyDir: string;
  let backend: ClusterLocalBackend;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-test-'));
    agencyDir = path.join(tmpDir, '.agency');
    await fs.mkdir(agencyDir, { recursive: true });

    backend = new ClusterLocalBackend({
      dataPath: path.join(tmpDir, 'credentials.dat'),
      keyPath: path.join(tmpDir, 'master.key'),
    });
    await backend.init();
    setCredentialBackend(backend);
  });

  afterEach(async () => {
    setRelayPushEvent(undefined as never);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes secret and metadata', async () => {
    const result = await writeCredential({
      credentialId: 'github-main-org',
      type: 'github-app',
      value: 'ghp_secret123',
      agencyDir,
    });

    expect(result).toEqual({ ok: true });

    // Verify secret persisted
    const secret = await backend.fetchSecret('github-main-org');
    expect(secret).toBe('ghp_secret123');

    // Verify metadata written
    const yamlPath = path.join(agencyDir, 'credentials.yaml');
    const raw = await fs.readFile(yamlPath, 'utf8');
    const parsed = YAML.parse(raw);
    expect(parsed.credentials['github-main-org'].type).toBe('github-app');
    expect(parsed.credentials['github-main-org'].backend).toBe('cluster-local');
    expect(parsed.credentials['github-main-org'].status).toBe('active');
    expect(parsed.credentials['github-main-org'].updatedAt).toBeTruthy();
  });

  it('emits relay event on success', async () => {
    const pushEvent = vi.fn();
    setRelayPushEvent(pushEvent);

    await writeCredential({
      credentialId: 'test-cred',
      type: 'api-key',
      value: 'sk-test',
      agencyDir,
    });

    expect(pushEvent).toHaveBeenCalledWith('cluster.credentials', {
      credentialId: 'test-cred',
      type: 'api-key',
      status: 'written',
    });
  });

  it('does not throw when relay not configured', async () => {
    await expect(writeCredential({
      credentialId: 'no-relay',
      type: 'api-key',
      value: 'val',
      agencyDir,
    })).resolves.toEqual({ ok: true });
  });

  it('overwrites metadata on second write', async () => {
    await writeCredential({
      credentialId: 'dup',
      type: 'api-key',
      value: 'v1',
      agencyDir,
    });

    await writeCredential({
      credentialId: 'dup',
      type: 'github-pat',
      value: 'v2',
      agencyDir,
    });

    const yamlPath = path.join(agencyDir, 'credentials.yaml');
    const parsed = YAML.parse(await fs.readFile(yamlPath, 'utf8'));
    expect(parsed.credentials['dup'].type).toBe('github-pat');
  });

  it('reports failedAt on metadata write error', async () => {
    // Make agencyDir read-only to trigger metadata write failure
    const readonlyDir = path.join(tmpDir, 'readonly');
    await fs.mkdir(readonlyDir);
    await fs.chmod(readonlyDir, 0o444);

    try {
      await writeCredential({
        credentialId: 'fail',
        type: 'api-key',
        value: 'val',
        agencyDir: path.join(readonlyDir, 'nonexistent'),
      });
      expect.fail('Should have thrown');
    } catch (err: unknown) {
      expect((err as { failedAt: string }).failedAt).toBe('metadata-write');
    } finally {
      await fs.chmod(readonlyDir, 0o755);
    }
  });
});
