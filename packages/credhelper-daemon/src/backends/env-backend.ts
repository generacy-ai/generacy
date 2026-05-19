import type { BackendClient } from '@generacy-ai/credhelper';
import { CredhelperError } from '../errors.js';

export class EnvBackend implements BackendClient {
  async fetchSecret(key: string): Promise<string> {
    const value = process.env[key];
    if (value === undefined) {
      throw new CredhelperError(
        'BACKEND_SECRET_NOT_FOUND',
        `Environment variable '${key}' is not set`,
        { backendType: 'env', key },
      );
    }
    return value;
  }
}
