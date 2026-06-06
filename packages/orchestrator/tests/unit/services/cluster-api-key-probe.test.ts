import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clusterApiKeyExists,
  DEFAULT_KEY_PATH,
} from '../../../src/services/cluster-api-key-probe.js';

describe('clusterApiKeyExists (#777)', () => {
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'cluster-api-key-probe-'));
    originalEnv = process.env['CLUSTER_API_KEY_PATH'];
    delete process.env['CLUSTER_API_KEY_PATH'];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['CLUSTER_API_KEY_PATH'] = originalEnv;
    } else {
      delete process.env['CLUSTER_API_KEY_PATH'];
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns true when key file exists at the explicit path', () => {
    const keyPath = path.join(tempDir, 'cluster-api-key');
    writeFileSync(keyPath, 'secret');
    expect(clusterApiKeyExists(keyPath)).toBe(true);
  });

  it('returns false when key file missing at the explicit path', () => {
    const keyPath = path.join(tempDir, 'does-not-exist');
    expect(clusterApiKeyExists(keyPath)).toBe(false);
  });

  it('honors explicit keyPath argument over CLUSTER_API_KEY_PATH env var', () => {
    const present = path.join(tempDir, 'present');
    const absent = path.join(tempDir, 'absent');
    writeFileSync(present, 'k');

    // Env points at a missing file, but explicit arg points at an existing one
    process.env['CLUSTER_API_KEY_PATH'] = absent;
    expect(clusterApiKeyExists(present)).toBe(true);

    // Inverse: env points at an existing file, but explicit arg points at a missing one
    process.env['CLUSTER_API_KEY_PATH'] = present;
    expect(clusterApiKeyExists(absent)).toBe(false);
  });

  it('honors CLUSTER_API_KEY_PATH env var when no explicit keyPath given', () => {
    const keyPath = path.join(tempDir, 'env-key');
    writeFileSync(keyPath, 'k');
    process.env['CLUSTER_API_KEY_PATH'] = keyPath;
    expect(clusterApiKeyExists()).toBe(true);
  });

  it('returns false when env var path is missing and no explicit keyPath given', () => {
    process.env['CLUSTER_API_KEY_PATH'] = path.join(tempDir, 'nope');
    expect(clusterApiKeyExists()).toBe(false);
  });

  it('DEFAULT_KEY_PATH matches the control-plane reader path', () => {
    // Must match `packages/control-plane/src/services/cluster-api-key.ts:4`.
    expect(DEFAULT_KEY_PATH).toBe('/var/lib/generacy/cluster-api-key');
  });
});
