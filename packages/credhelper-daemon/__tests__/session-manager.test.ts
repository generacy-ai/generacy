import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { SessionManager } from '../src/session-manager.js';
import { CredentialStore } from '../src/credential-store.js';
import { TokenRefresher } from '../src/token-refresher.js';
import { ExposureRenderer } from '../src/exposure-renderer.js';
import { CredhelperError } from '../src/errors.js';
import {
  createMockConfigLoader,
  createMockPluginRegistry,
  MOCK_ROLE,
  MOCK_CREDENTIAL,
  MOCK_BACKEND,
} from './mocks/mock-config-loader.js';
import { createMockPlugin } from './mocks/mock-plugin.js';
import type { ConfigLoader, PluginRegistry } from '../src/types.js';
import type { RoleConfig } from '@generacy-ai/credhelper';

let tmpDir: string;
let store: CredentialStore;
let refresher: TokenRefresher;
let renderer: ExposureRenderer;
let configLoader: ConfigLoader;
let pluginRegistry: PluginRegistry;

function createSessionManager(
  overrides?: Partial<{
    configLoader: ConfigLoader;
    pluginRegistry: PluginRegistry;
    store: CredentialStore;
    refresher: TokenRefresher;
    renderer: ExposureRenderer;
  }>,
) {
  return new SessionManager(
    overrides?.configLoader ?? configLoader,
    overrides?.pluginRegistry ?? pluginRegistry,
    overrides?.store ?? store,
    overrides?.refresher ?? refresher,
    overrides?.renderer ?? renderer,
    { sessionsDir: tmpDir, workerUid: 1000, workerGid: 1000 },
  );
}

describe('SessionManager', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'credhelper-sm-'));
    store = new CredentialStore();
    refresher = new TokenRefresher(store);
    renderer = new ExposureRenderer();

    const mockPlugin = createMockPlugin({
      supportedExposures: ['env', 'git-credential-helper', 'gcloud-external-account'],
    });
    configLoader = createMockConfigLoader();
    pluginRegistry = createMockPluginRegistry({ mock: mockPlugin });
  });

  afterEach(async () => {
    refresher.cancelAll();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('beginSession', () => {
    it('creates a session with correct session directory and expiry', async () => {
      const sm = createSessionManager();
      const result = await sm.beginSession({
        role: 'ci-runner',
        sessionId: 'sess-1',
      });

      expect(result.sessionDir).toBe(path.join(tmpDir, 'sess-1'));
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // Cleanup
      await sm.endSession('sess-1');
    });

    it('stores credentials in the credential store', async () => {
      const sm = createSessionManager();
      await sm.beginSession({ role: 'ci-runner', sessionId: 'sess-1' });

      const entry = store.get('sess-1', 'github-token');
      expect(entry).toBeDefined();
      expect(entry!.available).toBe(true);
      expect(entry!.value.value).toBe('mock-secret-value');

      await sm.endSession('sess-1');
    });

    it('creates the session directory on disk', async () => {
      const sm = createSessionManager();
      await sm.beginSession({ role: 'ci-runner', sessionId: 'sess-1' });

      const sessionDir = path.join(tmpDir, 'sess-1');
      const stat = await fs.stat(sessionDir);
      expect(stat.isDirectory()).toBe(true);

      await sm.endSession('sess-1');
    });

    it('binds a data socket for the session', async () => {
      const sm = createSessionManager();
      await sm.beginSession({ role: 'ci-runner', sessionId: 'sess-1' });

      const session = sm.getSession('sess-1');
      expect(session.dataServer).toBeDefined();
      expect(session.dataSocketPath).toBe(
        path.join(tmpDir, 'sess-1', 'data.sock'),
      );

      await sm.endSession('sess-1');
    });

    it('rejects duplicate session IDs', async () => {
      const sm = createSessionManager();
      await sm.beginSession({ role: 'ci-runner', sessionId: 'sess-1' });

      await expect(
        sm.beginSession({ role: 'ci-runner', sessionId: 'sess-1' }),
      ).rejects.toThrow(CredhelperError);

      try {
        await sm.beginSession({ role: 'ci-runner', sessionId: 'sess-1' });
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('INVALID_REQUEST');
      }

      await sm.endSession('sess-1');
    });

    it('throws ROLE_NOT_FOUND for invalid role', async () => {
      const sm = createSessionManager();

      try {
        await sm.beginSession({
          role: 'nonexistent-role',
          sessionId: 'sess-1',
        });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('ROLE_NOT_FOUND');
      }
    });

    it('throws UNSUPPORTED_EXPOSURE when plugin does not support the exposure kind', async () => {
      const limitedPlugin = createMockPlugin({
        supportedExposures: [], // supports nothing
      });

      const sm = createSessionManager({
        pluginRegistry: createMockPluginRegistry({ mock: limitedPlugin }),
      });

      try {
        await sm.beginSession({ role: 'ci-runner', sessionId: 'sess-1' });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('UNSUPPORTED_EXPOSURE');
      }
    });

    it('throws PLUGIN_MINT_FAILED when plugin mint fails', async () => {
      const failPlugin = createMockPlugin({ mintBehavior: 'failure' });

      const sm = createSessionManager({
        pluginRegistry: createMockPluginRegistry({ mock: failPlugin }),
      });

      try {
        await sm.beginSession({ role: 'ci-runner', sessionId: 'sess-1' });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('PLUGIN_MINT_FAILED');
      }
    });

    it('handles resolve-based credentials', async () => {
      // Create a credential without mint config
      const resolveCredential = {
        ...MOCK_CREDENTIAL,
        id: 'static-secret',
        mint: undefined,
      };
      const resolveRole: RoleConfig = {
        ...MOCK_ROLE,
        credentials: [
          { ref: 'static-secret', expose: [{ as: 'env' as const, name: 'SECRET' }] },
        ],
      };
      const resolvePlugin = createMockPlugin({
        resolveValue: { value: 'resolved-secret' },
      });

      const sm = createSessionManager({
        configLoader: createMockConfigLoader({
          roles: { 'ci-runner': resolveRole },
          credentials: { 'static-secret': resolveCredential },
        }),
        pluginRegistry: createMockPluginRegistry({ mock: resolvePlugin }),
      });

      await sm.beginSession({ role: 'ci-runner', sessionId: 'sess-1' });

      const entry = store.get('sess-1', 'static-secret');
      expect(entry).toBeDefined();
      expect(entry!.value.value).toBe('resolved-secret');

      await sm.endSession('sess-1');
    });
  });

  describe('endSession', () => {
    it('cleans up credential store on end', async () => {
      const sm = createSessionManager();
      await sm.beginSession({ role: 'ci-runner', sessionId: 'sess-1' });
      expect(store.get('sess-1', 'github-token')).toBeDefined();

      await sm.endSession('sess-1');
      expect(store.get('sess-1', 'github-token')).toBeUndefined();
    });

    it('removes the session directory', async () => {
      const sm = createSessionManager();
      await sm.beginSession({ role: 'ci-runner', sessionId: 'sess-1' });

      const sessionDir = path.join(tmpDir, 'sess-1');
      expect((await fs.stat(sessionDir).catch(() => null))).not.toBeNull();

      await sm.endSession('sess-1');
      const statAfter = await fs.stat(sessionDir).catch(() => null);
      expect(statAfter).toBeNull();
    });

    it('throws SESSION_NOT_FOUND for unknown session', async () => {
      const sm = createSessionManager();

      try {
        await sm.endSession('nonexistent');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('SESSION_NOT_FOUND');
      }
    });

    it('closes the data server', async () => {
      const sm = createSessionManager();
      await sm.beginSession({ role: 'ci-runner', sessionId: 'sess-1' });
      const session = sm.getSession('sess-1');
      const dataServer = session.dataServer;

      await sm.endSession('sess-1');

      // After close, the server should not be listening
      expect(dataServer.listening).toBe(false);
    });
  });

  describe('getSession', () => {
    it('returns session state for an active session', async () => {
      const sm = createSessionManager();
      await sm.beginSession({ role: 'ci-runner', sessionId: 'sess-1' });

      const session = sm.getSession('sess-1');
      expect(session.sessionId).toBe('sess-1');
      expect(session.roleId).toBe('ci-runner');
      expect(session.credentialIds).toContain('github-token');

      await sm.endSession('sess-1');
    });

    it('throws SESSION_NOT_FOUND for unknown session', () => {
      const sm = createSessionManager();
      expect(() => sm.getSession('nonexistent')).toThrow(CredhelperError);
    });
  });

  describe('endAll', () => {
    it('ends all active sessions', async () => {
      const sm = createSessionManager();
      await sm.beginSession({ role: 'ci-runner', sessionId: 'sess-1' });
      await sm.beginSession({ role: 'ci-runner', sessionId: 'sess-2' });

      await sm.endAll();

      expect(() => sm.getSession('sess-1')).toThrow(CredhelperError);
      expect(() => sm.getSession('sess-2')).toThrow(CredhelperError);
      expect(store.get('sess-1', 'github-token')).toBeUndefined();
      expect(store.get('sess-2', 'github-token')).toBeUndefined();
    });
  });

  describe('expiry sweeper', () => {
    it('auto-cleans expired sessions', async () => {
      const sm = createSessionManager();

      await sm.beginSession({ role: 'ci-runner', sessionId: 'sess-1' });

      // Spy on endSession to confirm it gets called
      const endSpy = vi.spyOn(sm, 'endSession');

      // Manually set expiry to the past
      const session = sm.getSession('sess-1');
      session.expiresAt = new Date(Date.now() - 1000);

      sm.startSweeper(50);

      // Wait for sweep to fire and async cleanup to complete
      await new Promise((r) => setTimeout(r, 200));

      expect(endSpy).toHaveBeenCalledWith('sess-1');
      expect(() => sm.getSession('sess-1')).toThrow(CredhelperError);

      sm.stopSweeper();
    });
  });
});
