import type { BackendClient } from '@generacy-ai/credhelper';
import { CredhelperError } from '../errors.js';
import type { SessionTokenProvider } from '../auth/session-token-store.js';

export class GeneracyCloudBackend implements BackendClient {
  constructor(
    private readonly apiUrl: string,
    private readonly sessionTokenProvider: SessionTokenProvider,
  ) {}

  async fetchSecret(key: string): Promise<string> {
    const token = await this.sessionTokenProvider.getToken();
    if (!token) {
      throw new CredhelperError(
        'BACKEND_AUTH_REQUIRED',
        'generacy-cloud backend requires authentication — run `stack secrets login` inside the worker container',
      );
    }

    const url = `${this.apiUrl}/api/organizations/${token.claims.org_id}/credentials/${encodeURIComponent(key)}/resolve`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.value}` },
    });

    if (response.status === 401) {
      throw new CredhelperError(
        'BACKEND_AUTH_EXPIRED',
        'session expired, run `stack secrets login` again',
      );
    }
    if (response.status === 404) {
      throw new CredhelperError(
        'CREDENTIAL_NOT_FOUND',
        `credential '${key}' not found in generacy-cloud`,
      );
    }
    if (!response.ok) {
      throw new CredhelperError(
        'BACKEND_UNREACHABLE',
        `generacy-cloud returned ${response.status}`,
      );
    }

    const body = (await response.json()) as { value: string };
    return body.value;
  }
}
