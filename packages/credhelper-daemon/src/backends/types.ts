import type { BackendClient, WritableBackendClient, BackendEntry } from '@generacy-ai/credhelper';

export type { WritableBackendClient };

export interface BackendClientFactory {
  create(backend: BackendEntry): BackendClient;
}
