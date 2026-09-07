import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { scaffoldDockerCompose } from '../scaffolder.js';

/**
 * Claude Code keeps OAuth credentials in ~/.config/anthropic, which is
 * container-local — sharing the claude-config volume alone leaves every worker
 * unauthenticated and each phase exits "Not logged in" in <1s.
 * ANTHROPIC_CONFIG_DIR relocates that store into the shared volume, and like
 * GENERACY_CLUSTER_ROLE it is a pair: landing it on one service only is a
 * broken state, so assert both here.
 */
describe('scaffoldDockerCompose: shared Claude auth store', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'scaffolder-claude-auth-env-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('points ANTHROPIC_CONFIG_DIR into the shared claude-config volume on BOTH services', () => {
    scaffoldDockerCompose(dir, baseInput);
    const parsed = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));

    const expected = 'ANTHROPIC_CONFIG_DIR=/home/node/.claude/anthropic-config';
    const orch = parsed.services.orchestrator;
    const worker = parsed.services.worker;

    expect(orch.environment as string[]).toContain(expected);
    expect(worker.environment as string[]).toContain(expected);

    // The relocation only works because the target lives under the shared
    // named volume — assert the mount both services depend on is still there.
    expect(orch.volumes as string[]).toContain('claude-config:/home/node/.claude');
    expect(worker.volumes as string[]).toContain('claude-config:/home/node/.claude');
  });
});
