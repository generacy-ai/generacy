import type { BackendClient, BackendEntry } from '@generacy-ai/credhelper';
import type { BackendClientFactory } from './types.js';
import { EnvBackend } from './env-backend.js';
import { GeneracyCloudBackend } from './generacy-cloud-backend.js';
import { CredhelperError } from '../errors.js';
import type { SessionTokenStore } from '../auth/session-token-store.js';

const SUPPORTED_TYPES = ['env', 'generacy-cloud'] as const;

export class DefaultBackendClientFactory implements BackendClientFactory {
  constructor(
    private readonly apiUrl?: string,
    private readonly sessionTokenStore?: SessionTokenStore,
  ) {}

  create(backend: BackendEntry): BackendClient {
    switch (backend.type) {
      case 'env':
        return new EnvBackend();
      case 'generacy-cloud':
        if (!this.apiUrl) {
          throw new CredhelperError(
            'BACKEND_UNREACHABLE',
            'generacy-cloud backend requires GENERACY_CLOUD_API_URL to be set',
          );
        }
        if (!this.sessionTokenStore) {
          throw new CredhelperError(
            'BACKEND_UNREACHABLE',
            'generacy-cloud backend requires a session token store',
          );
        }
        return new GeneracyCloudBackend(this.apiUrl, this.sessionTokenStore);
      default:
        throw new CredhelperError(
          'BACKEND_UNREACHABLE',
          `Unknown backend type '${backend.type}'. Supported types: ${SUPPORTED_TYPES.join(', ')}`,
          { backendType: backend.type, supportedTypes: [...SUPPORTED_TYPES] },
        );
    }
  }
}
