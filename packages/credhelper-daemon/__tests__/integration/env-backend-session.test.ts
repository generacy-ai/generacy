import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { CredentialStore } from '../../src/credential-store.js';
import { TokenRefresher } from '../../src/token-refresher.js';
import { ExposureRenderer } from '../../src/exposure-renderer.js';
import { SessionManager } from '../../src/session-manager.js';
import { DefaultBackendClientFactory } from '../../src/backends/factory.js';
import { createMockPlugin } from '../mocks/mock-plugin.js';
import type { ConfigLoader, PluginRegistry } from '../../src/types.js';
import type { RoleConfig, CredentialEntry, BackendEntry } from '@generacy-ai/credhelper';

const TEST_SECRET_KEY = 'CREDHELPER_INT_TEST_SECRET';
const TEST_SECRET_VALUE = 'my-secret-value';

const testBackend: BackendEntry = {
  id: 'env-local',
  type: 'env',
};

const testCredential: CredentialEntry = {
  id: 'test-cred',
  type: 'mock',
  backend: 'env-local',
  backendKey: TEST_SECRET_KEY,
};

const testRole: RoleConfig = {
  schemaVersion: '1',
  id: 'test-role',
  description: 'Test role with env-backed credential',
  credentials: [
    {
      ref: 'test-cred',
      expose: [{ as: 'env', name: 'TEST_CRED_VALUE' }],
    },
  ],
};

function createTestConfigLoader(): ConfigLoader {
  return {
    async loadRole(roleId: string): Promise<RoleConfig> {
      if (roleId === 'test-role') return testRole;
      throw new Error(`Role not found: ${roleId}`);
    },
    async loadCredential(credentialId: string): Promise<CredentialEntry> {
      if (credentialId === 'test-cred') return testCredential;
      throw new Error(`Credential not found: ${credentialId}`);
    },
    async loadBackend(backendId: string): Promise<BackendEntry> {
      if (backendId === 'env-local') return testBackend;
      throw new Error(`Backend not found: ${backendId}`);
    },
  };
}

describe('Integration: EnvBackend Session', () => {
  let tmpDir: string;
  let store: CredentialStore;
  let refresher: TokenRefresher;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'credhelper-env-int-'));
    const sessionsDir = path.join(tmpDir, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });

    // Set the test env var
    process.env[TEST_SECRET_KEY] = TEST_SECRET_VALUE;

    // Use a resolve-based mock plugin (no mint) so the credential resolves
    // directly via backend.fetchSecret(backendKey)
    const mockPlugin = createMockPlugin({
      supportedExposures: ['env'],
      resolveValue: { value: 'placeholder' }, // will be overridden
    });

    // Override resolve to actually call backend.fetchSecret
    mockPlugin.mint = undefined;
    mockPlugin.resolve = async (ctx) => {
      const secret = await ctx.backend.fetchSecret(ctx.backendKey);
      return { value: secret };
    };

    const pluginRegistry: PluginRegistry = {
      getPlugin(credentialType: string) {
        if (credentialType === 'mock') return mockPlugin;
        throw new Error(`Plugin not found: ${credentialType}`);
      },
    };

    store = new CredentialStore();
    refresher = new TokenRefresher(store);
    const renderer = new ExposureRenderer();
    const backendFactory = new DefaultBackendClientFactory();

    sessionManager = new SessionManager(
      createTestConfigLoader(),
      pluginRegistry,
      backendFactory,
      store,
      refresher,
      renderer,
      { sessionsDir, workerUid: 1000, workerGid: 1000, scratchBaseDir: path.join(tmpDir, 'scratch') },
    );
  });

  afterEach(async () => {
    delete process.env[TEST_SECRET_KEY];
    refresher.cancelAll();
    await sessionManager.endAll().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('resolves credential via real EnvBackend end-to-end', async () => {
    const result = await sessionManager.beginSession({
      role: 'test-role',
      sessionId: 'env-test-session',
    });

    expect(result.sessionDir).toContain('env-test-session');

    // Verify the credential was stored with the real env value
    const entry = store.get('env-test-session', 'test-cred');
    expect(entry).toBeDefined();
    expect(entry!.available).toBe(true);
    expect(entry!.value.value).toBe(TEST_SECRET_VALUE);

    // Verify the env file was rendered with the real secret
    const envFile = path.join(result.sessionDir, 'env');
    const envContent = await fs.readFile(envFile, 'utf-8');
    expect(envContent).toContain(`TEST_CRED_VALUE=${TEST_SECRET_VALUE}`);

    await sessionManager.endSession('env-test-session');
  });
});
