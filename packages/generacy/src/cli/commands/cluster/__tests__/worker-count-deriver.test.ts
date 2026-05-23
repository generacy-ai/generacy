import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Logger } from 'pino';

import {
  deriveWorkerCount,
  syncEnvWorkerCount,
  reconcileWorkerCount,
  applyWorkerCountToEnv,
} from '../worker-count-deriver.js';

function makeLogger(): { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function asLogger(l: ReturnType<typeof makeLogger>): Logger {
  return l as unknown as Logger;
}

describe('deriveWorkerCount', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deriver-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('positive integer → returns value with source cluster.yaml and no warnings', async () => {
    writeFileSync(join(dir, 'cluster.yaml'), 'workers: 5\n');
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(5);
    expect(result.source).toBe('cluster.yaml');
    expect(result.warnings).toEqual([]);
  });

  it('workers: 0 → clamps to 1 with clamped source and warning', async () => {
    writeFileSync(join(dir, 'cluster.yaml'), 'workers: 0\n');
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(1);
    expect(result.source).toBe('clamped');
    expect(result.warnings.some((w) => /workers: 0/.test(w))).toBe(true);
    expect(result.warnings.some((w) => /clamping to 1/.test(w))).toBe(true);
  });

  it('workers: -3 → clamps to 1 with clamped source and warning including -3', async () => {
    writeFileSync(join(dir, 'cluster.yaml'), 'workers: -3\n');
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(1);
    expect(result.source).toBe('clamped');
    expect(result.warnings.some((w) => w.includes('-3'))).toBe(true);
    expect(result.warnings.some((w) => /clamping to 1/.test(w))).toBe(true);
  });

  it('non-integer number (workers: 1.5) → defaults to 1 with default source', async () => {
    writeFileSync(join(dir, 'cluster.yaml'), 'workers: 1.5\n');
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(1);
    expect(result.source).toBe('default');
    expect(result.warnings.some((w) => /malformed/.test(w))).toBe(true);
  });

  it('string ("five") → defaults to 1 with default source', async () => {
    writeFileSync(join(dir, 'cluster.yaml'), 'workers: "five"\n');
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(1);
    expect(result.source).toBe('default');
    expect(result.warnings.some((w) => /malformed/.test(w))).toBe(true);
    expect(result.warnings.some((w) => w.includes('five'))).toBe(true);
  });

  it('null → defaults to 1 with default source', async () => {
    writeFileSync(join(dir, 'cluster.yaml'), 'workers: null\n');
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(1);
    expect(result.source).toBe('default');
    expect(result.warnings.some((w) => /malformed/.test(w))).toBe(true);
  });

  it('array → defaults to 1 with default source', async () => {
    writeFileSync(join(dir, 'cluster.yaml'), 'workers:\n  - 1\n  - 2\n');
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(1);
    expect(result.source).toBe('default');
    expect(result.warnings.some((w) => /malformed/.test(w))).toBe(true);
  });

  it('object → defaults to 1 with default source', async () => {
    writeFileSync(join(dir, 'cluster.yaml'), 'workers:\n  count: 5\n');
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(1);
    expect(result.source).toBe('default');
    expect(result.warnings.some((w) => /malformed/.test(w))).toBe(true);
  });

  it('missing workers key → defaults to 1 with default source', async () => {
    writeFileSync(join(dir, 'cluster.yaml'), 'channel: stable\nvariant: cluster-base\n');
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(1);
    expect(result.source).toBe('default');
    expect(result.warnings.some((w) => /no workers field/.test(w))).toBe(true);
  });

  it('missing cluster.yaml file → defaults to 1 with default source', async () => {
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(1);
    expect(result.source).toBe('default');
    expect(result.warnings.some((w) => /cluster\.yaml not found/.test(w))).toBe(true);
  });

  it('corrupt YAML → defaults to 1 with default source', async () => {
    writeFileSync(join(dir, 'cluster.yaml'), '{workers: [unterminated\n');
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(1);
    expect(result.source).toBe('default');
    expect(result.warnings.some((w) => /not valid YAML/.test(w))).toBe(true);
  });

  it('does not throw on any input', async () => {
    // Already covered above implicitly. Sanity-check: empty yaml.
    writeFileSync(join(dir, 'cluster.yaml'), '');
    await expect(deriveWorkerCount(dir, asLogger(makeLogger()))).resolves.toBeDefined();
  });
});

describe('applyWorkerCountToEnv (pure)', () => {
  it('replaces existing WORKER_COUNT line in place, preserves others', () => {
    const before = [
      '# Comment',
      'GENERACY_CLUSTER_ID=abc',
      'WORKER_COUNT=1',
      'PROJECT_NAME=demo',
      '',
    ].join('\n');
    const after = applyWorkerCountToEnv(before, 5);
    const lines = after.split('\n');
    expect(lines[0]).toBe('# Comment');
    expect(lines[1]).toBe('GENERACY_CLUSTER_ID=abc');
    expect(lines[2]).toBe('WORKER_COUNT=5');
    expect(lines[3]).toBe('PROJECT_NAME=demo');
  });

  it('appends WORKER_COUNT when missing', () => {
    const before = 'GENERACY_CLUSTER_ID=abc\nPROJECT_NAME=demo\n';
    const after = applyWorkerCountToEnv(before, 3);
    expect(after).toBe('GENERACY_CLUSTER_ID=abc\nPROJECT_NAME=demo\nWORKER_COUNT=3\n');
  });

  it('appends with prepended newline when file does not end with newline', () => {
    const before = 'GENERACY_CLUSTER_ID=abc';
    const after = applyWorkerCountToEnv(before, 3);
    expect(after).toBe('GENERACY_CLUSTER_ID=abc\nWORKER_COUNT=3\n');
  });

  it('replace preserves all other lines byte-for-byte', () => {
    const before = '# header\n\n# group 1\nA=1\nWORKER_COUNT=99\nB=2\n# trailing\n';
    const after = applyWorkerCountToEnv(before, 7);
    expect(after).toBe('# header\n\n# group 1\nA=1\nWORKER_COUNT=7\nB=2\n# trailing\n');
  });
});

describe('syncEnvWorkerCount', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-env-test-'));
  });

  afterEach(() => {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // best effort
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('in-place replace preserves all other lines byte-for-byte', () => {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, '# Identity\nFOO=bar\nWORKER_COUNT=1\nBAZ=qux\n');
    const logger = makeLogger();
    const result = syncEnvWorkerCount(dir, 5, asLogger(logger));
    expect(result.wrote).toBe(true);
    const after = readFileSync(envPath, 'utf-8');
    expect(after).toBe('# Identity\nFOO=bar\nWORKER_COUNT=5\nBAZ=qux\n');
  });

  it('appends WORKER_COUNT when no existing line', () => {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'FOO=bar\n');
    const result = syncEnvWorkerCount(dir, 3, asLogger(makeLogger()));
    expect(result.wrote).toBe(true);
    expect(readFileSync(envPath, 'utf-8')).toBe('FOO=bar\nWORKER_COUNT=3\n');
  });

  it('skip-and-warn when .env missing; does not create file', () => {
    const logger = makeLogger();
    const result = syncEnvWorkerCount(dir, 5, asLogger(logger));
    expect(result.wrote).toBe(false);
    expect(result.reason).toBe('env-missing');
    expect(existsSync(join(dir, '.env'))).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.warn.mock.calls[0]![0]).toMatch(/skipped/);
  });

  it('write-failed path when directory becomes unwritable', () => {
    if (process.getuid && process.getuid() === 0) {
      // Skip in root context — chmod doesn't enforce against root.
      return;
    }
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'FOO=bar\n');
    chmodSync(dir, 0o500); // r-x for owner, no write
    const logger = makeLogger();
    const result = syncEnvWorkerCount(dir, 5, asLogger(logger));
    expect(result.wrote).toBe(false);
    expect(result.reason).toBe('write-failed');
    expect(result.error).toBeInstanceOf(Error);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('reconcileWorkerCount', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reconcile-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('positive value: no yaml rewrite, writes WORKER_COUNT to .env', async () => {
    const yamlPath = join(dir, 'cluster.yaml');
    const envPath = join(dir, '.env');
    writeFileSync(yamlPath, 'channel: stable\nworkers: 4\nvariant: cluster-base\n');
    writeFileSync(envPath, 'FOO=bar\nWORKER_COUNT=1\n');
    const yamlBefore = readFileSync(yamlPath, 'utf-8');

    const logger = makeLogger();
    const result = await reconcileWorkerCount(dir, asLogger(logger));

    expect(result.workerCount).toBe(4);
    expect(result.envWrote).toBe(true);
    expect(readFileSync(envPath, 'utf-8')).toContain('WORKER_COUNT=4');
    // cluster.yaml unchanged
    expect(readFileSync(yamlPath, 'utf-8')).toBe(yamlBefore);
  });

  it('idempotency: malformed yaml is never self-healed; both calls leave cluster.yaml byte-identical', async () => {
    const yamlPath = join(dir, 'cluster.yaml');
    const envPath = join(dir, '.env');
    writeFileSync(yamlPath, 'channel: stable\nworkers: "five"\nvariant: cluster-base\n');
    writeFileSync(envPath, 'FOO=bar\n');
    const yamlBefore = readFileSync(yamlPath, 'utf-8');

    const logger = makeLogger();
    const first = await reconcileWorkerCount(dir, asLogger(logger));
    expect(first.workerCount).toBe(1);
    expect(first.envWrote).toBe(true);

    // cluster.yaml is byte-identical to the original.
    expect(readFileSync(yamlPath, 'utf-8')).toBe(yamlBefore);
    const envAfterFirst = readFileSync(envPath, 'utf-8');
    expect(envAfterFirst).toContain('WORKER_COUNT=1');

    const second = await reconcileWorkerCount(dir, asLogger(logger));
    expect(second.workerCount).toBe(1);
    expect(readFileSync(yamlPath, 'utf-8')).toBe(yamlBefore);
    expect(readFileSync(envPath, 'utf-8')).toBe(envAfterFirst);
  });

  it('cluster.yaml is never rewritten even when workers is malformed', async () => {
    const yamlPath = join(dir, 'cluster.yaml');
    const original = 'channel: preview\nworkers: 0\nvariant: cluster-microservices\nappConfig:\n  schemaVersion: "1"\n  env: []\n  files: []\n';
    writeFileSync(yamlPath, original);
    writeFileSync(join(dir, '.env'), 'FOO=bar\n');

    await reconcileWorkerCount(dir, asLogger(makeLogger()));

    expect(readFileSync(yamlPath, 'utf-8')).toBe(original);
  });

  it('logs reconciled-info when .env was actually written', async () => {
    const yamlPath = join(dir, 'cluster.yaml');
    writeFileSync(yamlPath, 'channel: stable\nworkers: 2\nvariant: cluster-base\n');
    writeFileSync(join(dir, '.env'), 'WORKER_COUNT=1\n');

    const logger = makeLogger();
    await reconcileWorkerCount(dir, asLogger(logger));

    const infoCalls = logger.info.mock.calls.map((c) => c[0] as string);
    expect(infoCalls.some((m) => /Reconciled WORKER_COUNT from cluster.yaml: 2/.test(m))).toBe(true);
  });

  it('skips info-log and yaml-rewrite when .env missing but yaml is sane', async () => {
    const yamlPath = join(dir, 'cluster.yaml');
    writeFileSync(yamlPath, 'channel: stable\nworkers: 3\nvariant: cluster-base\n');

    const logger = makeLogger();
    const result = await reconcileWorkerCount(dir, asLogger(logger));
    expect(result.workerCount).toBe(3);
    expect(result.envWrote).toBe(false);
    // No .env created.
    expect(existsSync(join(dir, '.env'))).toBe(false);
    // cluster.yaml unchanged (source was cluster.yaml — no rewrite).
    expect(readFileSync(yamlPath, 'utf-8')).toContain('workers: 3');
  });
});

describe('deriveWorkerCount on unreadable cluster.yaml', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'unreadable-test-'));
  });

  afterEach(() => {
    try {
      const yamlPath = join(dir, 'cluster.yaml');
      if (existsSync(yamlPath)) chmodSync(yamlPath, 0o644);
    } catch {
      // best effort
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to default when read fails (permission denied)', async () => {
    if (process.getuid && process.getuid() === 0) {
      // Skip in root context — chmod doesn't enforce against root.
      return;
    }
    const yamlPath = join(dir, 'cluster.yaml');
    writeFileSync(yamlPath, 'workers: 5\n');
    chmodSync(yamlPath, 0o000);
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(1);
    expect(result.source).toBe('default');
  });
});

describe('deriveWorkerCount — merged cluster config (#712)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'merged-matrix-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('row 1: canonical valid (3), local absent → 3, cluster.yaml, no warnings', async () => {
    writeFileSync(join(dir, 'cluster.yaml'), 'workers: 3\n');
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(3);
    expect(result.source).toBe('cluster.yaml');
    expect(result.warnings).toEqual([]);
  });

  it('row 2: canonical valid (3), local valid (5) → 5, cluster.local.yaml, no warnings', async () => {
    writeFileSync(join(dir, 'cluster.yaml'), 'workers: 3\n');
    writeFileSync(join(dir, 'cluster.local.yaml'), 'workers: 5\n');
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(5);
    expect(result.source).toBe('cluster.local.yaml');
    expect(result.warnings).toEqual([]);
  });

  it('row 3: canonical valid (3), local malformed → 3, cluster.yaml, local-unreadable warning', async () => {
    writeFileSync(join(dir, 'cluster.yaml'), 'workers: 3\n');
    writeFileSync(join(dir, 'cluster.local.yaml'), 'workers: not-a-number\n');
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(3);
    expect(result.source).toBe('cluster.yaml');
    expect(result.warnings.some((w) => /cluster\.local\.yaml unreadable/.test(w))).toBe(true);
  });

  it('row 4: canonical absent, local valid (5) → 5, cluster.local.yaml, init recommendation', async () => {
    writeFileSync(join(dir, 'cluster.local.yaml'), 'workers: 5\n');
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(5);
    expect(result.source).toBe('cluster.local.yaml');
    expect(result.warnings.some((w) => /npx generacy init/.test(w))).toBe(true);
  });

  it('row 5: canonical absent, local absent → 1, default, not-found warning', async () => {
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(1);
    expect(result.source).toBe('default');
    expect(result.warnings.some((w) => /cluster\.yaml not found/.test(w))).toBe(true);
  });

  it('row 6: canonical malformed ("five"), local absent → 1, default, malformed warning', async () => {
    writeFileSync(join(dir, 'cluster.yaml'), 'workers: "five"\n');
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(1);
    expect(result.source).toBe('default');
    expect(result.warnings.some((w) => /malformed/.test(w))).toBe(true);
  });

  it('row 7: canonical malformed ("five"), local valid (5) → 5, cluster.local.yaml, local-unreadable warning', async () => {
    // Chosen warning text: "cluster.local.yaml unreadable; using cluster.yaml value".
    // It's slightly misleading here (local is the valid layer), but the deriver can't
    // reliably attribute the strict-schema rejection to a specific file; the result
    // is still correct — local wins per the local-wins rule.
    writeFileSync(join(dir, 'cluster.yaml'), 'workers: "five"\n');
    writeFileSync(join(dir, 'cluster.local.yaml'), 'workers: 5\n');
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(5);
    expect(result.source).toBe('cluster.local.yaml');
    expect(result.warnings.some((w) => /cluster\.local\.yaml unreadable/.test(w))).toBe(true);
  });

  it('row 8: canonical workers: 0, local absent → 1, clamped, clamping warning', async () => {
    writeFileSync(join(dir, 'cluster.yaml'), 'workers: 0\n');
    const result = await deriveWorkerCount(dir, asLogger(makeLogger()));
    expect(result.workerCount).toBe(1);
    expect(result.source).toBe('clamped');
    expect(result.warnings.some((w) => /clamping to 1/.test(w))).toBe(true);
  });
});

describe('reconcileWorkerCount regression #712', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reconcile-712-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('regression #712: scaled overlay survives reconcileWorkerCount; cluster.yaml byte-identical', async () => {
    const yamlPath = join(dir, 'cluster.yaml');
    const localPath = join(dir, 'cluster.local.yaml');
    const envPath = join(dir, '.env');
    writeFileSync(yamlPath, 'workers: 1\n');
    writeFileSync(localPath, 'workers: 5\n');
    writeFileSync(envPath, 'WORKER_COUNT=1\n');
    const yamlBefore = readFileSync(yamlPath, 'utf-8');

    const result = await reconcileWorkerCount(dir, asLogger(makeLogger()));

    expect(result.workerCount).toBe(5);
    expect(result.envWrote).toBe(true);
    expect(readFileSync(envPath, 'utf-8')).toContain('WORKER_COUNT=5');
    expect(readFileSync(yamlPath, 'utf-8')).toBe(yamlBefore);
  });
});

// Silence the "mkdirSync unused" warning when running under strict TS — mkdirSync
// is imported defensively in case future cases need it.
void mkdirSync;
