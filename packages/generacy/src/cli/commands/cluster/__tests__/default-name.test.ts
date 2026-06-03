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

  it('produces ten distinct names for ten siblings under one local projectId (SC-002)', () => {
    // Simulate adding ten clusters sequentially under the same project. Each
    // call sees the registry growing with the previously-generated names.
    const registry: Registry = [];
    const names: string[] = [];
    for (let i = 0; i < 10; i++) {
      const name = generateDefaultName('proj-1', 'ACME Frontend', registry);
      names.push(name);
      registry.push(entry({
        projectId: 'proj-1',
        deploymentMode: 'local',
        displayName: name,
      }));
    }
    expect(names).toEqual([
      'acme-frontend-local-1',
      'acme-frontend-local-2',
      'acme-frontend-local-3',
      'acme-frontend-local-4',
      'acme-frontend-local-5',
      'acme-frontend-local-6',
      'acme-frontend-local-7',
      'acme-frontend-local-8',
      'acme-frontend-local-9',
      'acme-frontend-local-10',
    ]);
    expect(new Set(names).size).toBe(10);
  });

  it('local and cloud sequences are independent under one projectId (SC-008)', () => {
    // Interleave local and cloud registrations under one project. The local
    // counter must ignore cloud entries entirely, so each new local cluster
    // continues the local sequence contiguously.
    const registry: Registry = [];
    const localNames: string[] = [];

    const addLocal = (displayName: string): void => {
      registry.push(entry({
        projectId: 'proj-1',
        deploymentMode: 'local',
        displayName,
      }));
    };
    const addCloud = (displayName: string): void => {
      registry.push(entry({
        projectId: 'proj-1',
        deploymentMode: 'cloud',
        displayName,
      }));
    };

    // local-1
    localNames.push(generateDefaultName('proj-1', 'ACME Frontend', registry));
    addLocal(localNames[localNames.length - 1]!);
    // cloud entry (ignored)
    addCloud('acme-frontend-cloud-a');
    // local-2 (still contiguous, not affected by cloud entry)
    localNames.push(generateDefaultName('proj-1', 'ACME Frontend', registry));
    addLocal(localNames[localNames.length - 1]!);
    // more cloud entries
    addCloud('acme-frontend-cloud-b');
    addCloud('acme-frontend-cloud-c');
    // local-3
    localNames.push(generateDefaultName('proj-1', 'ACME Frontend', registry));

    expect(localNames).toEqual([
      'acme-frontend-local-1',
      'acme-frontend-local-2',
      'acme-frontend-local-3',
    ]);
  });
});
