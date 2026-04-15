import type { BackendClient } from '@generacy-ai/credhelper';
import { CredhelperError } from '../errors.js';

export class GeneracyCloudBackend implements BackendClient {
  async fetchSecret(_key: string): Promise<string> {
    throw new CredhelperError(
      'NOT_IMPLEMENTED',
      'generacy-cloud backend not yet implemented — see Phase 7b. ' +
        'Use backend type "env" for now.',
    );
  }
}
