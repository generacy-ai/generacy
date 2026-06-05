import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createClusterApiKeyReader } from '../../src/services/cluster-api-key.js';
import { GitHelperError } from '../../src/types/git-token.js';

describe('createClusterApiKeyReader', () => {
  let tmpDir: string;
  let keyPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capr-test-'));
    keyPath = path.join(tmpDir, 'cluster-api-key');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('first read populates cache and returns key contents', async () => {
    await fs.writeFile(keyPath, 'first-key-value', { mode: 0o600 });
    const reader = createClusterApiKeyReader({ keyPath });

    const value = await reader.read();

    expect(value).toBe('first-key-value');
  });

  it('second read hits cache (does not re-read contents when mtime unchanged)', async () => {
    await fs.writeFile(keyPath, 'cached-value', { mode: 0o600 });
    const reader = createClusterApiKeyReader({ keyPath });

    const first = await reader.read();

    // Truncate the file in place but keep the same mtime by restoring it.
    const st = await fs.stat(keyPath);
    await fs.writeFile(keyPath, 'completely-different-bytes', { mode: 0o600 });
    await fs.utimes(keyPath, st.atime, st.mtime);

    const second = await reader.read();

    expect(first).toBe('cached-value');
    expect(second).toBe('cached-value');
  });

  it('mtime change forces re-read', async () => {
    await fs.writeFile(keyPath, 'original-key', { mode: 0o600 });
    const reader = createClusterApiKeyReader({ keyPath });

    const first = await reader.read();
    expect(first).toBe('original-key');

    // Wait long enough for filesystem mtime granularity (~10ms is enough on most FS,
    // but bump it to 50ms to be safe across CI environments).
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.writeFile(keyPath, 'rotated-key', { mode: 0o600 });

    const second = await reader.read();
    expect(second).toBe('rotated-key');
  });

  it('strips trailing newline from key file contents', async () => {
    await fs.writeFile(keyPath, 'key-with-trailing-newline\n', { mode: 0o600 });
    const reader = createClusterApiKeyReader({ keyPath });

    expect(await reader.read()).toBe('key-with-trailing-newline');
  });

  it('throws GitHelperError(CLUSTER_API_KEY_MISSING) when file is missing', async () => {
    const reader = createClusterApiKeyReader({ keyPath });

    await expect(reader.read()).rejects.toThrow(GitHelperError);
    try {
      await reader.read();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GitHelperError);
      expect((err as GitHelperError).code).toBe('CLUSTER_API_KEY_MISSING');
    }
  });

  it('uses default path when no keyPath option provided', () => {
    const reader = createClusterApiKeyReader();
    expect(typeof reader.read).toBe('function');
  });
});
