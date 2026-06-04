import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyBaseLogger } from 'fastify';

import {
  detectIdentitySplit,
  resetIdentitySplitDetectionState,
  type IdentitySplitEvent,
} from '../services/identity-split-detector.js';

function createMockLogger(): FastifyBaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => createMockLogger()),
    level: 'info',
    silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

function writeValidClusterJson(path: string, clusterId: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      cluster_id: clusterId,
      project_id: 'proj_test',
      org_id: 'org_test',
      cloud_url: 'https://api.example.test',
      activated_at: new Date().toISOString(),
    }),
  );
}

describe('detectIdentitySplit', () => {
  let tempDir: string;
  let clusterJsonPath: string;
  let logger: FastifyBaseLogger;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'identity-split-test-'));
    clusterJsonPath = join(tempDir, 'cluster.json');
    logger = createMockLogger();
    resetIdentitySplitDetectionState();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    resetIdentitySplitDetectionState();
  });

  it('returns match and does not emit when env id equals cluster.json id', async () => {
    const id = 'cluster-aaa';
    writeValidClusterJson(clusterJsonPath, id);
    const sendRelayEvent = vi.fn();

    const outcome = await detectIdentitySplit({
      clusterJsonPath,
      env: { GENERACY_CLUSTER_ID: id },
      sendRelayEvent,
      logger,
    });

    expect(outcome).toEqual({ kind: 'match', clusterId: id });
    expect(sendRelayEvent).not.toHaveBeenCalled();
  });

  it('emits exactly one relay event with the correct payload shape on mismatch (first call)', async () => {
    const envId = 'env-id-aaa';
    const jsonId = 'json-id-bbb';
    writeValidClusterJson(clusterJsonPath, jsonId);
    const sendRelayEvent = vi.fn();

    const outcome = await detectIdentitySplit({
      clusterJsonPath,
      env: { GENERACY_CLUSTER_ID: envId },
      sendRelayEvent,
      logger,
    });

    expect(outcome.kind).toBe('mismatch');
    if (outcome.kind === 'mismatch') {
      expect(outcome.envClusterId).toBe(envId);
      expect(outcome.clusterJsonClusterId).toBe(jsonId);
      expect(outcome.emitted).toBe(true);
    }

    expect(sendRelayEvent).toHaveBeenCalledTimes(1);
    const [channel, payload] = sendRelayEvent.mock.calls[0] as [
      string,
      IdentitySplitEvent,
    ];
    expect(channel).toBe('cluster.identity-split');
    expect(payload.env_cluster_id).toBe(envId);
    expect(payload.cluster_json_cluster_id).toBe(jsonId);
    expect(payload.detected_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
    );
  });

  it('suppresses subsequent emissions across the same process lifetime (FR-005)', async () => {
    const envId = 'env-id-aaa';
    const jsonId = 'json-id-bbb';
    writeValidClusterJson(clusterJsonPath, jsonId);
    const sendRelayEvent = vi.fn();

    const first = await detectIdentitySplit({
      clusterJsonPath,
      env: { GENERACY_CLUSTER_ID: envId },
      sendRelayEvent,
      logger,
    });
    const second = await detectIdentitySplit({
      clusterJsonPath,
      env: { GENERACY_CLUSTER_ID: envId },
      sendRelayEvent,
      logger,
    });

    expect(first.kind).toBe('mismatch');
    expect(second.kind).toBe('mismatch');
    if (first.kind === 'mismatch') expect(first.emitted).toBe(true);
    if (second.kind === 'mismatch') expect(second.emitted).toBe(false);

    expect(sendRelayEvent).toHaveBeenCalledTimes(1);
  });

  it('returns no-env when GENERACY_CLUSTER_ID is unset (no event)', async () => {
    writeValidClusterJson(clusterJsonPath, 'json-id-bbb');
    const sendRelayEvent = vi.fn();

    const outcome = await detectIdentitySplit({
      clusterJsonPath,
      env: {},
      sendRelayEvent,
      logger,
    });

    expect(outcome).toEqual({ kind: 'no-env', envClusterId: undefined });
    expect(sendRelayEvent).not.toHaveBeenCalled();
  });

  it('returns no-env when GENERACY_CLUSTER_ID is empty string (no event)', async () => {
    writeValidClusterJson(clusterJsonPath, 'json-id-bbb');
    const sendRelayEvent = vi.fn();

    const outcome = await detectIdentitySplit({
      clusterJsonPath,
      env: { GENERACY_CLUSTER_ID: '' },
      sendRelayEvent,
      logger,
    });

    expect(outcome.kind).toBe('no-env');
    expect(sendRelayEvent).not.toHaveBeenCalled();
  });

  it('returns no-cluster-json when cluster.json is missing (no event)', async () => {
    const sendRelayEvent = vi.fn();

    const outcome = await detectIdentitySplit({
      clusterJsonPath: join(tempDir, 'does-not-exist.json'),
      env: { GENERACY_CLUSTER_ID: 'env-id-aaa' },
      sendRelayEvent,
      logger,
    });

    expect(outcome).toEqual({
      kind: 'no-cluster-json',
      envClusterId: 'env-id-aaa',
    });
    expect(sendRelayEvent).not.toHaveBeenCalled();
  });

  it('returns no-cluster-json when cluster.json is corrupt (no event)', async () => {
    writeFileSync(clusterJsonPath, '{ this is not json');
    const sendRelayEvent = vi.fn();

    const outcome = await detectIdentitySplit({
      clusterJsonPath,
      env: { GENERACY_CLUSTER_ID: 'env-id-aaa' },
      sendRelayEvent,
      logger,
    });

    expect(outcome.kind).toBe('no-cluster-json');
    expect(sendRelayEvent).not.toHaveBeenCalled();
  });

  it('swallows sendRelayEvent throws, logs error, and still flips hasEmitted (single attempt counts)', async () => {
    const envId = 'env-id-aaa';
    const jsonId = 'json-id-bbb';
    writeValidClusterJson(clusterJsonPath, jsonId);
    const sendRelayEvent = vi.fn(() => {
      throw new Error('relay client exploded');
    });

    const first = await detectIdentitySplit({
      clusterJsonPath,
      env: { GENERACY_CLUSTER_ID: envId },
      sendRelayEvent,
      logger,
    });

    // First call: emission attempt counted, error logged & swallowed
    expect(first.kind).toBe('mismatch');
    if (first.kind === 'mismatch') expect(first.emitted).toBe(true);
    expect(sendRelayEvent).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();

    // Second call: suppressed (hasEmitted is true even though previous send threw)
    const second = await detectIdentitySplit({
      clusterJsonPath,
      env: { GENERACY_CLUSTER_ID: envId },
      sendRelayEvent,
      logger,
    });

    expect(second.kind).toBe('mismatch');
    if (second.kind === 'mismatch') expect(second.emitted).toBe(false);
    expect(sendRelayEvent).toHaveBeenCalledTimes(1);
  });
});
