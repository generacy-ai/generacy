import { DefaultBackendClientFactory } from '../../src/backends/factory.js';
import { EnvBackend } from '../../src/backends/env-backend.js';
import { GeneracyCloudBackend } from '../../src/backends/generacy-cloud-backend.js';
import { CredhelperError } from '../../src/errors.js';
import type { SessionTokenStore } from '../../src/auth/session-token-store.js';
import type { BackendEntry } from '@generacy-ai/credhelper';

const stubTokenStore = {
  getToken: async () => null,
} as unknown as SessionTokenStore;

describe('DefaultBackendClientFactory', () => {
  const factory = new DefaultBackendClientFactory(
    'https://api.generacy.test',
    stubTokenStore,
  );

  it('creates an EnvBackend for type "env"', () => {
    const backend: BackendEntry = { id: 'env-local', type: 'env' };
    const client = factory.create(backend);
    expect(client).toBeInstanceOf(EnvBackend);
  });

  it('creates a GeneracyCloudBackend for type "generacy-cloud"', () => {
    const backend: BackendEntry = { id: 'cloud-prod', type: 'generacy-cloud' };
    const client = factory.create(backend);
    expect(client).toBeInstanceOf(GeneracyCloudBackend);
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
      expect((err as CredhelperError).message).toContain('generacy-cloud');
    }
  });
});
