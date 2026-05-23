import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMergedClusterConfig } from '../cluster-config.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cluster-config-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('readMergedClusterConfig', () => {
  it('returns empty objects when both files are missing', async () => {
    const result = await readMergedClusterConfig(tempDir);
    expect(result).toEqual({ merged: {}, canonical: {}, local: {} });
  });

  it('returns canonical-only view when only cluster.yaml exists', async () => {
    writeFileSync(
      join(tempDir, 'cluster.yaml'),
      'channel: stable\nworkers: 1\nvariant: cluster-base\n',
    );

    const result = await readMergedClusterConfig(tempDir);
    expect(result.canonical).toEqual({
      channel: 'stable',
      workers: 1,
      variant: 'cluster-base',
    });
    expect(result.local).toEqual({});
    expect(result.merged).toEqual({
      channel: 'stable',
      workers: 1,
      variant: 'cluster-base',
    });
  });

  it('returns local-only view when only cluster.local.yaml exists', async () => {
    writeFileSync(join(tempDir, 'cluster.local.yaml'), 'workers: 3\n');

    const result = await readMergedClusterConfig(tempDir);
    expect(result.canonical).toEqual({});
    expect(result.local).toEqual({ workers: 3 });
    expect(result.merged).toEqual({ workers: 3 });
  });

  it('unions disjoint keys from both files', async () => {
    writeFileSync(
      join(tempDir, 'cluster.yaml'),
      'channel: stable\nvariant: cluster-base\n',
    );
    writeFileSync(join(tempDir, 'cluster.local.yaml'), 'workers: 5\n');

    const result = await readMergedClusterConfig(tempDir);
    expect(result.merged).toEqual({
      channel: 'stable',
      variant: 'cluster-base',
      workers: 5,
    });
  });

  it('local wins for overlapping keys (workers)', async () => {
    writeFileSync(
      join(tempDir, 'cluster.yaml'),
      'channel: stable\nworkers: 1\n',
    );
    writeFileSync(join(tempDir, 'cluster.local.yaml'), 'workers: 7\n');

    const result = await readMergedClusterConfig(tempDir);
    expect(result.merged.workers).toBe(7);
    expect(result.merged.channel).toBe('stable');
    expect(result.canonical.workers).toBe(1);
    expect(result.local.workers).toBe(7);
  });

  it('throws on malformed canonical YAML', async () => {
    writeFileSync(
      join(tempDir, 'cluster.yaml'),
      'channel: stable\n  bad: : :\n - "',
    );

    await expect(readMergedClusterConfig(tempDir)).rejects.toThrow(/cluster\.yaml/);
  });

  it('throws on malformed local YAML', async () => {
    writeFileSync(join(tempDir, 'cluster.yaml'), 'channel: stable\n');
    writeFileSync(
      join(tempDir, 'cluster.local.yaml'),
      'workers: 3\n  bad: : :\n - "',
    );

    await expect(readMergedClusterConfig(tempDir)).rejects.toThrow(/cluster\.local\.yaml/);
  });

  it('passes through appConfig as unknown', async () => {
    writeFileSync(
      join(tempDir, 'cluster.yaml'),
      `appConfig:
  env:
    - name: FOO
      secret: false
  files: []
  secrets: []
`,
    );

    const result = await readMergedClusterConfig(tempDir);
    expect(result.merged.appConfig).toBeDefined();
    expect(result.canonical.appConfig).toBeDefined();
  });

  it('handles empty cluster.local.yaml gracefully', async () => {
    writeFileSync(join(tempDir, 'cluster.yaml'), 'workers: 2\n');
    writeFileSync(join(tempDir, 'cluster.local.yaml'), '');

    const result = await readMergedClusterConfig(tempDir);
    expect(result.merged.workers).toBe(2);
    expect(result.local).toEqual({});
  });
});
