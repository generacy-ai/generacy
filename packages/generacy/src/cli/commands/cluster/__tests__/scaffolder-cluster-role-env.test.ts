import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { scaffoldDockerCompose } from '../scaffolder.js';

/**
 * T032 — the `GENERACY_CLUSTER_ROLE` env-var pair is the invariant. Landing
 * one without the other is a broken state. Assert both in the same test.
 */
describe('scaffoldDockerCompose: GENERACY_CLUSTER_ROLE env pair (Q2-A)', () => {
  let dir: string;

  const baseInput = {
    imageTag: 'ghcr.io/generacy-ai/cluster-base:1.5.0',
    clusterId: 'clust_abc',
    projectId: 'proj_def',
    projectName: 'todo-list-example',
    cloudUrl: 'https://api.generacy.ai',
    variant: 'cluster-base' as const,
    orgId: 'org_xyz',
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scaffolder-role-env-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits GENERACY_CLUSTER_ROLE=orchestrator on orchestrator AND =worker on worker', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    const orchEnv = parsed.services.orchestrator.environment as string[];
    const workerEnv = parsed.services.worker.environment as string[];

    expect(orchEnv).toContain('GENERACY_CLUSTER_ROLE=orchestrator');
    expect(workerEnv).toContain('GENERACY_CLUSTER_ROLE=worker');
  });
});
