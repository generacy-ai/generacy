import type { BackendClient, BackendEntry } from '@generacy-ai/credhelper';

import { CredhelperError } from '../errors.js';
import { GeneracyCloudBackend } from './generacy-cloud-backend.js';
import type { SessionTokenStore } from '../auth/session-token-store.js';

/**
 * Simple env-var backend: reads secrets from process.env.
 */
class EnvBackend implements BackendClient {
  async fetchSecret(key: string): Promise<string> {
    const value = process.env[key];
    if (value === undefined) {
      throw new CredhelperError(
        'CREDENTIAL_NOT_FOUND',
        `Environment variable '${key}' not set`,
      );
    }
    return value;
  }
}

/**
 * Factory that creates BackendClient instances based on BackendEntry.type.
 *
 * Dispatches:
 *   - "env" → EnvBackend (reads process.env)
 *   - "generacy-cloud" �� GeneracyCloudBackend (fetches from cloud API with Bearer auth)
 */
export class BackendClientFactory {
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
          'NOT_IMPLEMENTED',
          `Backend type '${backend.type}' is not implemented`,
        );
    }
  }
}
