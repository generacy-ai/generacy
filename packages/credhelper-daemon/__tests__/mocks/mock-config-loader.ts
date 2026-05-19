import type { ConfigLoader, PluginRegistry } from '../../src/types.js';
import type { RoleConfig, CredentialEntry, BackendEntry, CredentialTypePlugin } from '@generacy-ai/credhelper';
import type { BackendClientFactory } from '../../src/backends/types.js';

// Fixture data
export const MOCK_BACKEND: BackendEntry = {
  id: 'vault-dev',
  type: 'vault',
  endpoint: 'http://vault:8200',
  auth: { mode: 'token' },
};

export const MOCK_CREDENTIAL: CredentialEntry = {
  id: 'github-token',
  type: 'mock',
  backend: 'vault-dev',
  backendKey: 'secret/github-token',
  mint: { ttl: '1h' },
};

export const MOCK_ROLE: RoleConfig = {
  schemaVersion: '1',
  id: 'ci-runner',
  description: 'CI runner role with GitHub access',
  credentials: [
    {
      ref: 'github-token',
      expose: [{ as: 'env', name: 'GITHUB_TOKEN' }],
    },
  ],
};

export function createMockConfigLoader(overrides?: {
  roles?: Record<string, RoleConfig>;
  credentials?: Record<string, CredentialEntry>;
  backends?: Record<string, BackendEntry>;
}): ConfigLoader {
  const roles = overrides?.roles ?? { 'ci-runner': MOCK_ROLE };
  const credentials = overrides?.credentials ?? { 'github-token': MOCK_CREDENTIAL };
  const backends = overrides?.backends ?? { 'vault-dev': MOCK_BACKEND };

  return {
    async loadRole(roleId: string): Promise<RoleConfig> {
      const role = roles[roleId];
      if (!role) throw new Error(`Role not found: ${roleId}`);
      return role;
    },
    async loadCredential(credentialId: string): Promise<CredentialEntry> {
      const cred = credentials[credentialId];
      if (!cred) throw new Error(`Credential not found: ${credentialId}`);
      return cred;
    },
    async loadBackend(backendId: string): Promise<BackendEntry> {
      const backend = backends[backendId];
      if (!backend) throw new Error(`Backend not found: ${backendId}`);
      return backend;
    },
  };
}

export function createMockBackendFactory(mockSecret = 'mock-secret-value'): BackendClientFactory {
  return {
    create() {
      return {
        async fetchSecret() {
          return mockSecret;
        },
      };
    },
  };
}

export function createMockPluginRegistry(plugins?: Record<string, CredentialTypePlugin>): PluginRegistry {
  const registry = plugins ?? {};
  return {
    getPlugin(credentialType: string): CredentialTypePlugin {
      const plugin = registry[credentialType];
      if (!plugin) throw new Error(`Plugin not found for type: ${credentialType}`);
      return plugin;
    },
  };
}
