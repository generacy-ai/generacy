import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readKeyFile, writeKeyFile, readClusterJson, writeClusterJson } from '../persistence.js';
import type { ClusterJson } from '../types.js';

describe('persistence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'activation-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('readKeyFile', () => {
    it('returns null for missing file', async () => {
      const result = await readKeyFile(join(tempDir, 'nonexistent'));
      expect(result).toBeNull();
    });

    it('returns null for empty file', async () => {
      const filePath = join(tempDir, 'empty-key');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(filePath, '');
      const result = await readKeyFile(filePath);
      expect(result).toBeNull();
    });

    it('returns trimmed key content', async () => {
      const filePath = join(tempDir, 'key');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(filePath, '  my-api-key\n  ');
      const result = await readKeyFile(filePath);
      expect(result).toBe('my-api-key');
    });
  });

  describe('writeKeyFile', () => {
    it('writes key atomically (no .tmp file remaining)', async () => {
      const filePath = join(tempDir, 'subdir', 'key');
      await writeKeyFile(filePath, 'secret-key');

      const content = await readFile(filePath, 'utf-8');
      expect(content).toBe('secret-key');

      // .tmp should not exist
      await expect(stat(`${filePath}.tmp`)).rejects.toThrow();
    });

    it('sets mode 0600 on key file', async () => {
      const filePath = join(tempDir, 'key');
      await writeKeyFile(filePath, 'secret-key');

      const stats = await stat(filePath);
      // 0600 = 0o100600, check permission bits
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it('round-trips with readKeyFile', async () => {
      const filePath = join(tempDir, 'roundtrip-key');
      await writeKeyFile(filePath, 'my-secret-key');
      const result = await readKeyFile(filePath);
      expect(result).toBe('my-secret-key');
    });
  });

  describe('readClusterJson', () => {
    it('returns null for missing file', async () => {
      const result = await readClusterJson(join(tempDir, 'nonexistent.json'));
      expect(result).toBeNull();
    });

    it('returns null for invalid JSON', async () => {
      const filePath = join(tempDir, 'invalid.json');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(filePath, 'not json');
      const result = await readClusterJson(filePath);
      expect(result).toBeNull();
    });

    it('returns null for JSON that fails schema validation', async () => {
      const filePath = join(tempDir, 'bad-schema.json');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(filePath, JSON.stringify({ cluster_id: 'c1' })); // Missing fields
      const result = await readClusterJson(filePath);
      expect(result).toBeNull();
    });
  });

  describe('writeClusterJson', () => {
    const validData: ClusterJson = {
      cluster_id: 'cluster_1',
      project_id: 'proj_1',
      org_id: 'org_1',
      cloud_url: 'https://api.generacy.ai',
      activated_at: '2024-01-01T00:00:00.000Z',
    };

    it('writes valid cluster.json', async () => {
      const filePath = join(tempDir, 'cluster.json');
      await writeClusterJson(filePath, validData);

      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed).toEqual(validData);
    });

    it('sets mode 0644 on cluster.json', async () => {
      const filePath = join(tempDir, 'cluster.json');
      await writeClusterJson(filePath, validData);

      const stats = await stat(filePath);
      expect(stats.mode & 0o777).toBe(0o644);
    });

    it('round-trips with readClusterJson', async () => {
      const filePath = join(tempDir, 'roundtrip.json');
      await writeClusterJson(filePath, validData);
      const result = await readClusterJson(filePath);
      expect(result).toEqual(validData);
    });
  });
});
