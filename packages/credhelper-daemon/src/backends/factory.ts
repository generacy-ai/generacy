import type { BackendClient, BackendEntry } from '@generacy-ai/credhelper';
import type { BackendClientFactory } from './types.js';
import { EnvBackend } from './env-backend.js';
import { CredhelperError } from '../errors.js';

export class DefaultBackendClientFactory implements BackendClientFactory {
  create(backend: BackendEntry): BackendClient {
    switch (backend.type) {
      case 'env':
        return new EnvBackend();
      default:
        throw new CredhelperError(
          'BACKEND_UNREACHABLE',
          `Unknown backend type '${backend.type}'. Supported types: env, cluster-local`,
          { backendType: backend.type, supportedTypes: ['env', 'cluster-local'] },
        );
    }
  }
}
