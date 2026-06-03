import { describe, it, expect } from 'vitest';
import { generateDefaultName } from '../default-name.js';
import type { Registry, RegistryEntry } from '../registry.js';

function entry(overrides: Partial<RegistryEntry>): RegistryEntry {
  return {
    clusterId: 'cid-test',
    name: 'project',
    path: '/tmp/p',
    composePath: '/tmp/p/.generacy/docker-compose.yml',
    variant: 'cluster-base',
    channel: 'stable',
    cloudUrl: null,
    lastSeen: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('generateDefaultName', () => {
  it('returns <project>-local-1 for empty registry', () => {
    const out = generateDefaultName('proj-1', 'ACME Frontend', []);
    expect(out).toBe('acme-frontend-local-1');
  });

  it('fills contiguous gaps in sequence', () => {
    const registry: Registry = [
      entry({ projectId: 'proj-1', deploymentMode: 'local', displayName: 'acme-frontend-local-1' }),
      entry({ projectId: 'proj-1', deploymentMode: 'local', displayName: 'acme-frontend-local-2' }),
      entry({ projectId: 'proj-1', deploymentMode: 'local', displayName: 'acme-frontend-local-4' }),
    ];
    expect(generateDefaultName('proj-1', 'ACME Frontend', registry)).toBe('acme-frontend-local-3');
  });

  it('isolates sequences by projectId', () => {
    const registry: Registry = [
      entry({ projectId: 'proj-A', deploymentMode: 'local', displayName: 'acme-frontend-local-1' }),
      entry({ projectId: 'proj-A', deploymentMode: 'local', displayName: 'acme-frontend-local-2' }),
    ];
    // Different project should still start at 1.
    expect(generateDefaultName('proj-B', 'ACME Frontend', registry)).toBe('acme-frontend-local-1');
  });

  it('ignores cloud-mode entries', () => {
    const registry: Registry = [
      entry({ projectId: 'proj-1', deploymentMode: 'cloud', displayName: 'acme-frontend-local-1' }),
      entry({ projectId: 'proj-1', deploymentMode: 'cloud', displayName: 'acme-frontend-local-2' }),
    ];
    expect(generateDefaultName('proj-1', 'ACME Frontend', registry)).toBe('acme-frontend-local-1');
  });

  it('treats missing deploymentMode as local', () => {
    const registry: Registry = [
      entry({ projectId: 'proj-1', displayName: 'acme-frontend-local-1' }),
    ];
    expect(generateDefaultName('proj-1', 'ACME Frontend', registry)).toBe('acme-frontend-local-2');
  });

  it('excludes entries missing projectId from sequencing', () => {
    const registry: Registry = [
      entry({ deploymentMode: 'local', displayName: 'acme-frontend-local-1' }),
    ];
    expect(generateDefaultName('proj-1', 'ACME Frontend', registry)).toBe('acme-frontend-local-1');
  });

  it('sanitizes the project component', () => {
    expect(generateDefaultName('proj-1', '@scope/pkg-name', [])).toBe('scope-pkg-name-local-1');
  });

  it('skips entries with missing displayName', () => {
    const registry: Registry = [
      entry({ projectId: 'proj-1', deploymentMode: 'local' }),
    ];
    expect(generateDefaultName('proj-1', 'ACME Frontend', registry)).toBe('acme-frontend-local-1');
  });
});
