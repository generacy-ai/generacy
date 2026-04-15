import type { BackendClient, BackendEntry } from '@generacy-ai/credhelper';

export interface BackendClientFactory {
  create(backend: BackendEntry): BackendClient;
}
