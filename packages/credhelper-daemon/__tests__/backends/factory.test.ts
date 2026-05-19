import { DefaultBackendClientFactory } from '../../src/backends/factory.js';
import { EnvBackend } from '../../src/backends/env-backend.js';
import { ClusterLocalBackend } from '../../src/backends/cluster-local-backend.js';
import { CredhelperError } from '../../src/errors.js';
import type { BackendEntry } from '@generacy-ai/credhelper';

describe('DefaultBackendClientFactory', () => {
  const factory = new DefaultBackendClientFactory();

  it('creates an EnvBackend for type "env"', () => {
    const backend: BackendEntry = { id: 'env-local', type: 'env' };
    const client = factory.create(backend);
    expect(client).toBeInstanceOf(EnvBackend);
  });

  it('creates a ClusterLocalBackend for type "cluster-local"', () => {
    const backend: BackendEntry = { id: 'local-store', type: 'cluster-local' };
    const client = factory.create(backend);
    expect(client).toBeInstanceOf(ClusterLocalBackend);
  });

  it('throws BACKEND_UNREACHABLE for unknown type with supported types list', () => {
    const backend: BackendEntry = { id: 'custom', type: 'unknown-backend' };
    try {
      factory.create(backend);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CredhelperError);
      expect((err as CredhelperError).code).toBe('BACKEND_UNREACHABLE');
      expect((err as CredhelperError).message).toContain('unknown-backend');
      expect((err as CredhelperError).message).toContain('env');
      expect((err as CredhelperError).message).toContain('cluster-local');
    }
  });
});
