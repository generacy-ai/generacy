import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CredentialTypePlugin, RoleConfig, CredentialEntry, BackendEntry } from '@generacy-ai/credhelper';

import { CORE_PLUGINS } from '../../src/plugins/core/index.js';
import { CredentialStore } from '../../src/credential-store.js';
import { TokenRefresher } from '../../src/token-refresher.js';
import { ExposureRenderer } from '../../src/exposure-renderer.js';
import { SessionManager } from '../../src/session-manager.js';
import { DefaultBackendClientFactory } from '../../src/backends/factory.js';
import { createMockBackendFactory } from '../mocks/mock-config-loader.js';
import type { ConfigLoader, PluginRegistry } from '../../src/types.js';

function createCorePluginRegistry(): PluginRegistry {
  const map = new Map<string, CredentialTypePlugin>();
  for (const plugin of CORE_PLUGINS) {
    map.set(plugin.type, plugin);
  }
  return {
    getPlugin(credentialType: string) {
      const plugin = map.get(credentialType);
      if (!plugin) throw new Error(`No plugin for type: ${credentialType}`);
      return plugin;
    },
  };
}

describe('Integration: Core Plugins', () => {
  let tmpDir: string;
  let sessionsDir: string;
  let store: CredentialStore;
  let refresher: TokenRefresher;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'credhelper-core-'));
    sessionsDir = path.join(tmpDir, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    store = new CredentialStore();
    refresher = new TokenRefresher(store);
  });

  afterEach(async () => {
    refresher.cancelAll();
    if (sessionManager) {
      sessionManager.stopSweeper();
      await sessionManager.endAll().catch(() => {});
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('all 7 core plugins register in a PluginRegistry', () => {
    const registry = createCorePluginRegistry();
    const expectedTypes = [
      'github-app',
      'github-pat',
      'gcp-service-account',
      'aws-sts',
      'stripe-restricted-key',
      'api-key',
      'env-passthrough',
    ];
    for (const type of expectedTypes) {
      const plugin = registry.getPlugin(type);
      expect(plugin.type).toBe(type);
      expect(typeof plugin.renderExposure).toBe('function');
      expect(plugin.supportedExposures.length).toBeGreaterThan(0);
    }
  });

  it('each core plugin has a unique type string', () => {
    const types = CORE_PLUGINS.map((p) => p.type);
    expect(new Set(types).size).toBe(CORE_PLUGINS.length);
  });

  describe('end-to-end session with env-passthrough plugin', () => {
    it('creates session, renders env file, serves credential, cleans up', async () => {
      const backend: BackendEntry = {
        id: 'env-backend',
        type: 'env',
        endpoint: '',
        auth: { mode: 'none' },
      };
      const credential: CredentialEntry = {
        id: 'my-secret',
        type: 'env-passthrough',
        backend: 'env-backend',
        backendKey: 'MY_SECRET_VAR',
      };
      const role: RoleConfig = {
        schemaVersion: '1',
        id: 'test-role',
        description: 'Test role with env-passthrough',
        credentials: [
          { ref: 'my-secret', expose: [{ as: 'env', name: 'MY_SECRET' }] },
        ],
      };

      const configLoader: ConfigLoader = {
        async loadRole() { return role; },
        async loadCredential() { return credential; },
        async loadBackend() { return backend; },
      };

      // Set env var so the real EnvBackend can resolve it
      process.env['MY_SECRET_VAR'] = 'test-env-secret';

      const renderer = new ExposureRenderer();
      const registry = createCorePluginRegistry();
      sessionManager = new SessionManager(
        configLoader, registry, new DefaultBackendClientFactory(), store, refresher, renderer,
        { sessionsDir, workerUid: 1000, workerGid: 1000 },
      );

      const { sessionDir } = await sessionManager.beginSession({
        role: 'test-role',
        sessionId: 'env-pass-session',
      });

      // Verify session directory created
      const stat = await fs.stat(sessionDir);
      expect(stat.isDirectory()).toBe(true);

      // Verify env file rendered
      const envContent = await fs.readFile(path.join(sessionDir, 'env'), 'utf-8');
      expect(envContent).toContain('MY_SECRET=');

      // Verify credential stored
      const entry = store.get('env-pass-session', 'my-secret');
      expect(entry).toBeDefined();
      expect(entry!.credentialType).toBe('env-passthrough');

      // Cleanup
      delete process.env['MY_SECRET_VAR'];
      await sessionManager.endSession('env-pass-session');
      const statAfter = await fs.stat(sessionDir).catch(() => null);
      expect(statAfter).toBeNull();
    });
  });

  describe('end-to-end session with github-pat plugin', () => {
    it('renders env and git-credential-helper exposures', async () => {
      const backend: BackendEntry = {
        id: 'vault',
        type: 'vault',
        endpoint: 'http://vault:8200',
        auth: { mode: 'token' },
      };
      const credential: CredentialEntry = {
        id: 'gh-pat',
        type: 'github-pat',
        backend: 'vault',
        backendKey: 'secret/gh-pat',
      };
      const role: RoleConfig = {
        schemaVersion: '1',
        id: 'dev-role',
        description: 'Developer role with GitHub PAT',
        credentials: [
          {
            ref: 'gh-pat',
            expose: [
              { as: 'env', name: 'GITHUB_TOKEN' },
              { as: 'git-credential-helper' },
            ],
          },
        ],
      };

      const configLoader: ConfigLoader = {
        async loadRole() { return role; },
        async loadCredential() { return credential; },
        async loadBackend() { return backend; },
      };

      const renderer = new ExposureRenderer();
      const registry = createCorePluginRegistry();
      sessionManager = new SessionManager(
        configLoader, registry, createMockBackendFactory('ghp_test123'), store, refresher, renderer,
        { sessionsDir, workerUid: 1000, workerGid: 1000 },
      );

      const { sessionDir } = await sessionManager.beginSession({
        role: 'dev-role',
        sessionId: 'gh-pat-session',
      });

      // Verify env file
      const envContent = await fs.readFile(path.join(sessionDir, 'env'), 'utf-8');
      expect(envContent).toContain('GITHUB_TOKEN=');

      // Verify git credential helper files
      const gitDir = path.join(sessionDir, 'git');
      const gitConfig = await fs.readFile(path.join(gitDir, 'config'), 'utf-8');
      expect(gitConfig).toContain('[credential]');
      expect(gitConfig).toContain('credential-helper');

      const helperScript = await fs.readFile(path.join(gitDir, 'credential-helper'), 'utf-8');
      expect(helperScript).toContain('#!/bin/sh');
      expect(helperScript).toContain('data.sock');

      // Cleanup
      await sessionManager.endSession('gh-pat-session');
    });
  });

  describe('exposure rendering pipeline', () => {
    it('plugin env data flows through renderer to session env file', async () => {
      const renderer = new ExposureRenderer();
      const sessionDir = path.join(tmpDir, 'render-test');
      await renderer.renderSessionDir(sessionDir);

      // Simulate what session-manager does: plugin.renderExposure → renderer.renderPluginExposure
      const plugin = CORE_PLUGINS.find((p) => p.type === 'stripe-restricted-key')!;
      const secret = { value: 'rk_test_abc123' };
      const exposureData = plugin.renderExposure('env', secret, { kind: 'env', name: 'STRIPE_API_KEY' });

      expect(exposureData.kind).toBe('env');
      if (exposureData.kind === 'env') {
        expect(exposureData.entries[0].key).toBe('STRIPE_API_KEY');
        expect(exposureData.entries[0].value).toBe('rk_test_abc123');
      }

      await renderer.renderPluginExposure(sessionDir, path.join(sessionDir, 'data.sock'), 'stripe-key', exposureData);

      const envContent = await fs.readFile(path.join(sessionDir, 'env'), 'utf-8');
      expect(envContent).toContain('STRIPE_API_KEY=rk_test_abc123');
    });

    it('plugin git-credential-helper data flows through renderer to session git files', async () => {
      const renderer = new ExposureRenderer();
      const sessionDir = path.join(tmpDir, 'render-git-test');
      await renderer.renderSessionDir(sessionDir);
      const dataSocketPath = path.join(sessionDir, 'data.sock');

      const plugin = CORE_PLUGINS.find((p) => p.type === 'github-pat')!;
      const secret = { value: 'ghp_test123' };
      const exposureData = plugin.renderExposure('git-credential-helper', secret, { kind: 'git-credential-helper' });

      expect(exposureData.kind).toBe('git-credential-helper');
      if (exposureData.kind === 'git-credential-helper') {
        expect(exposureData.host).toBe('github.com');
        expect(exposureData.username).toBe('x-access-token');
      }

      await renderer.renderPluginExposure(sessionDir, dataSocketPath, 'gh-pat', exposureData);

      const gitConfig = await fs.readFile(path.join(sessionDir, 'git', 'config'), 'utf-8');
      expect(gitConfig).toContain('[credential]');

      const helperScript = await fs.readFile(path.join(sessionDir, 'git', 'credential-helper'), 'utf-8');
      expect(helperScript).toContain(dataSocketPath);
    });

    it('plugin localhost-proxy data flows through renderer to proxy config', async () => {
      const renderer = new ExposureRenderer();
      const sessionDir = path.join(tmpDir, 'render-proxy-test');
      await renderer.renderSessionDir(sessionDir);
      const dataSocketPath = path.join(sessionDir, 'data.sock');

      const plugin = CORE_PLUGINS.find((p) => p.type === 'api-key')!;

      // api-key plugin needs resolve() called first to set lastResolvedConfig
      await plugin.resolve!({
        credentialId: 'test-key',
        backendKey: 'secret/api-key',
        backend: { fetchSecret: async () => 'sk-test-key-123' },
        config: { upstream: 'https://api.example.com' },
      });

      const secret = { value: 'sk-test-key-123', format: 'key' as const };
      const exposureData = plugin.renderExposure('localhost-proxy', secret, { kind: 'localhost-proxy', port: 0 });

      expect(exposureData.kind).toBe('localhost-proxy');
      if (exposureData.kind === 'localhost-proxy') {
        expect(exposureData.upstream).toBe('https://api.example.com');
        expect(exposureData.headers.Authorization).toContain('Bearer sk-test-key-123');
      }

      // renderPluginExposure for localhost-proxy is a no-op — the real proxy
      // is wired by SessionManager. Verify plugin exposure data is correct.
      await renderer.renderPluginExposure(sessionDir, dataSocketPath, 'api-key', exposureData);
    });
  });
});
