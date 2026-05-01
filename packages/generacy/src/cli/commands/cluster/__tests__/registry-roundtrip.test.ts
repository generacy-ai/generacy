import { describe, it, expect } from 'vitest';
import { RegistryEntrySchema } from '../registry.js';

describe('RegistryEntrySchema validation', () => {
  const validEntry = {
    clusterId: 'clust_abc123',
    name: 'my-project',
    path: '/home/user/Generacy/my-project',
    composePath: '/home/user/Generacy/my-project/.generacy/docker-compose.yml',
    variant: 'cluster-base' as const,
    channel: 'stable' as const,
    cloudUrl: 'https://api.generacy.ai',
    lastSeen: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  it('accepts a valid launch-created entry', () => {
    const result = RegistryEntrySchema.safeParse(validEntry);
    expect(result.success).toBe(true);
  });

  it('accepts cluster-microservices variant', () => {
    const result = RegistryEntrySchema.safeParse({
      ...validEntry,
      variant: 'cluster-microservices',
    });
    expect(result.success).toBe(true);
  });

  it('rejects old "standard" variant', () => {
    const result = RegistryEntrySchema.safeParse({
      ...validEntry,
      variant: 'standard',
    });
    expect(result.success).toBe(false);
  });

  it('rejects old "microservices" variant', () => {
    const result = RegistryEntrySchema.safeParse({
      ...validEntry,
      variant: 'microservices',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid channel enum', () => {
    const result = RegistryEntrySchema.safeParse({
      ...validEntry,
      channel: 'nightly',
    });
    expect(result.success).toBe(false);
  });

  it('accepts nullable clusterId for pre-activation', () => {
    const result = RegistryEntrySchema.safeParse({
      ...validEntry,
      clusterId: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts managementEndpoint for deploy entries', () => {
    const result = RegistryEntrySchema.safeParse({
      ...validEntry,
      managementEndpoint: 'ssh://user@host:22/path',
    });
    expect(result.success).toBe(true);
  });
});
