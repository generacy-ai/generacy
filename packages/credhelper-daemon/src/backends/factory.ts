import type { BackendClient, BackendEntry } from '@generacy-ai/credhelper';
import type { BackendClientFactory } from './types.js';
import { EnvBackend } from './env-backend.js';
import { GeneracyCloudBackend } from './generacy-cloud-backend.js';
import { CredhelperError } from '../errors.js';

const SUPPORTED_TYPES = ['env', 'generacy-cloud'] as const;

export class DefaultBackendClientFactory implements BackendClientFactory {
  create(backend: BackendEntry): BackendClient {
    switch (backend.type) {
      case 'env':
        return new EnvBackend();
      case 'generacy-cloud':
        return new GeneracyCloudBackend();
      default:
        throw new CredhelperError(
          'BACKEND_UNREACHABLE',
          `Unknown backend type '${backend.type}'. Supported types: ${SUPPORTED_TYPES.join(', ')}`,
          { backendType: backend.type, supportedTypes: [...SUPPORTED_TYPES] },
        );
    }
  }
}
