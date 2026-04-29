import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { SessionManager } from '../../src/session-manager.js';
import { CredentialStore } from '../../src/credential-store.js';
import { TokenRefresher } from '../../src/token-refresher.js';
import { ExposureRenderer } from '../../src/exposure-renderer.js';
import { CredhelperError } from '../../src/errors.js';
import {
  createMockConfigLoader,
  createMockBackendFactory,
  createMockPluginRegistry,
  MOCK_CREDENTIAL,
  MOCK_BACKEND,
} from '../mocks/mock-config-loader.js';
import { createMockPlugin } from '../mocks/mock-plugin.js';
import type { RoleConfig, CredentialEntry } from '@generacy-ai/credhelper';

const PROXY_PORT = 19880;

/** Role config with a localhost-proxy exposure (SendGrid-style). */
const SENDGRID_ROLE: RoleConfig = {
  schemaVersion: '1',
  id: 'sendgrid-role',
  description: 'Role with SendGrid localhost proxy',
  credentials: [
    {
      ref: 'sendgrid-key',
      expose: [{ as: 'localhost-proxy', port: PROXY_PORT }],
    },
  ],
  proxy: {
    'sendgrid-key': {
      upstream: 'https://api.sendgrid.com',
      default: 'deny',
      allow: [
        { method: 'POST', path: '/v3/mail/send' },
        { method: 'GET', path: '/v3/messages/{id}' },
      ],
    },
  },
};

const SENDGRID_CREDENTIAL: CredentialEntry = {
  id: 'sendgrid-key',
  type: 'mock',
  backend: 'vault-dev',
  backendKey: 'secret/sendgrid',
};

/** Create a mock plugin that supports localhost-proxy exposure. */
function createLocalhostProxyPlugin(upstreamUrl: string) {
  const plugin = createMockPlugin({
    supportedExposures: ['localhost-proxy'],
    resolveValue: { value: 'SG.fake-api-key' },
  });

  // Override renderExposure to return localhost-proxy data
  plugin.renderExposure = (kind, secret, _cfg) => {
    if (kind === 'localhost-proxy') {
      return {
        kind: 'localhost-proxy',
        upstream: upstreamUrl,
        headers: { Authorization: `Bearer ${secret.value}` },
      };
    }
    throw new Error(`Unsupported exposure: ${kind}`);
  };

  return plugin;
}

/** Make an HTTP request to a TCP port. */
function makeRequest(
  port: number,
  method: string,
  reqPath: string,
  body?: string,
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path: reqPath, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('Integration: localhost-proxy', () => {
  let tmpDir: string;
  let store: CredentialStore;
  let refresher: TokenRefresher;
  let sessionManager: SessionManager;
  let upstream: http.Server;
  let upstreamPort: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'credhelper-lhp-'));
    const sessionsDir = path.join(tmpDir, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });

    store = new CredentialStore();
    refresher = new TokenRefresher(store);

    // Start a fake upstream that echoes request details
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            receivedMethod: req.method,
            receivedPath: req.url,
            receivedAuth: req.headers['authorization'],
            receivedBody: Buffer.concat(chunks).toString(),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    upstreamPort = (upstream.address() as { port: number }).port;

    // Build role config pointing to our local upstream
    const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;
    const role: RoleConfig = {
      ...SENDGRID_ROLE,
      proxy: {
        'sendgrid-key': {
          ...SENDGRID_ROLE.proxy!['sendgrid-key']!,
          upstream: upstreamUrl,
        },
      },
    };

    const plugin = createLocalhostProxyPlugin(upstreamUrl);
    const configLoader = createMockConfigLoader({
      roles: { 'sendgrid-role': role },
      credentials: { 'sendgrid-key': SENDGRID_CREDENTIAL },
      backends: { 'vault-dev': MOCK_BACKEND },
    });

    sessionManager = new SessionManager(
      configLoader,
      createMockPluginRegistry({ mock: plugin }),
      createMockBackendFactory(),
      store,
      refresher,
      new ExposureRenderer(),
      { sessionsDir, workerUid: 1000, workerGid: 1000 },
    );
  });

  afterEach(async () => {
    refresher.cancelAll();
    await sessionManager.endAll().catch(() => {});
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // --- T040: Happy path ---
  it('forwards allowed POST through proxy with auth header injected', async () => {
    await sessionManager.beginSession({
      role: 'sendgrid-role',
      sessionId: 'sess-proxy-1',
    });

    const res = await makeRequest(
      PROXY_PORT,
      'POST',
      '/v3/mail/send',
      '{"to":"test@example.com"}',
    );
    expect(res.statusCode).toBe(200);

    const data = JSON.parse(res.body);
    expect(data.receivedMethod).toBe('POST');
    expect(data.receivedPath).toBe('/v3/mail/send');
    expect(data.receivedAuth).toBe('Bearer SG.fake-api-key');
    expect(data.receivedBody).toBe('{"to":"test@example.com"}');
  });

  // --- T041: Default deny ---
  it('returns 403 for GET on POST-only path', async () => {
    await sessionManager.beginSession({
      role: 'sendgrid-role',
      sessionId: 'sess-proxy-2',
    });

    const res = await makeRequest(PROXY_PORT, 'GET', '/v3/mail/send');
    expect(res.statusCode).toBe(403);

    const data = JSON.parse(res.body);
    expect(data.code).toBe('PROXY_ACCESS_DENIED');
    expect(data.details.method).toBe('GET');
    expect(data.details.path).toBe('/v3/mail/send');
  });

  it('returns 403 for arbitrary path', async () => {
    await sessionManager.beginSession({
      role: 'sendgrid-role',
      sessionId: 'sess-proxy-3',
    });

    const res = await makeRequest(PROXY_PORT, 'GET', '/v3/arbitrary/path');
    expect(res.statusCode).toBe(403);

    const data = JSON.parse(res.body);
    expect(data.code).toBe('PROXY_ACCESS_DENIED');
  });

  // --- T042: Teardown ---
  it('releases port after session ends', async () => {
    await sessionManager.beginSession({
      role: 'sendgrid-role',
      sessionId: 'sess-proxy-4',
    });

    // Verify proxy is listening
    const res = await makeRequest(PROXY_PORT, 'POST', '/v3/mail/send');
    expect(res.statusCode).toBe(200);

    // End session — proxy should be stopped
    await sessionManager.endSession('sess-proxy-4');

    // Verify port is released by binding a new server on it
    const testServer = http.createServer();
    await new Promise<void>((resolve, reject) => {
      testServer.on('error', reject);
      testServer.listen(PROXY_PORT, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => {
      testServer.close(() => resolve());
    });
  });

  // --- T043: Validation — missing proxy: entry ---
  it('fails session creation with PROXY_CONFIG_MISSING when proxy entry is absent', async () => {
    // Create a role that uses localhost-proxy but has no proxy config
    const badRole: RoleConfig = {
      schemaVersion: '1',
      id: 'bad-proxy-role',
      description: 'Missing proxy config',
      credentials: [
        {
          ref: 'sendgrid-key',
          expose: [{ as: 'localhost-proxy', port: PROXY_PORT }],
        },
      ],
      // proxy field intentionally omitted
    };

    const plugin = createLocalhostProxyPlugin(`http://127.0.0.1:${upstreamPort}`);
    const configLoader = createMockConfigLoader({
      roles: { 'bad-proxy-role': badRole },
      credentials: { 'sendgrid-key': SENDGRID_CREDENTIAL },
      backends: { 'vault-dev': MOCK_BACKEND },
    });

    const sm = new SessionManager(
      configLoader,
      createMockPluginRegistry({ mock: plugin }),
      createMockBackendFactory(),
      store,
      refresher,
      new ExposureRenderer(),
      { sessionsDir: path.join(tmpDir, 'sessions'), workerUid: 1000, workerGid: 1000 },
    );

    try {
      await sm.beginSession({ role: 'bad-proxy-role', sessionId: 'sess-bad' });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CredhelperError);
      expect((err as CredhelperError).code).toBe('PROXY_CONFIG_MISSING');
      expect((err as CredhelperError).message).toContain('sendgrid-key');
    }
  });

  // --- T044: Env var ---
  it('writes proxy URL to session env file with default envName', async () => {
    const result = await sessionManager.beginSession({
      role: 'sendgrid-role',
      sessionId: 'sess-proxy-5',
    });

    const envContent = await fs.readFile(
      path.join(result.sessionDir, 'env'),
      'utf-8',
    );
    expect(envContent).toContain(`SENDGRID_KEY_PROXY_URL=http://127.0.0.1:${PROXY_PORT}`);
  });

  it('writes proxy URL with custom envName when specified', async () => {
    const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

    // Build role with custom envName
    const customRole: RoleConfig = {
      ...SENDGRID_ROLE,
      credentials: [
        {
          ref: 'sendgrid-key',
          expose: [{ as: 'localhost-proxy', port: PROXY_PORT, envName: 'SENDGRID_API_URL' }],
        },
      ],
      proxy: {
        'sendgrid-key': {
          ...SENDGRID_ROLE.proxy!['sendgrid-key']!,
          upstream: upstreamUrl,
        },
      },
    };

    const plugin = createLocalhostProxyPlugin(upstreamUrl);
    const configLoader = createMockConfigLoader({
      roles: { 'custom-env-role': customRole },
      credentials: { 'sendgrid-key': SENDGRID_CREDENTIAL },
      backends: { 'vault-dev': MOCK_BACKEND },
    });

    const sm = new SessionManager(
      configLoader,
      createMockPluginRegistry({ mock: plugin }),
      createMockBackendFactory(),
      store,
      refresher,
      new ExposureRenderer(),
      { sessionsDir: path.join(tmpDir, 'sessions'), workerUid: 1000, workerGid: 1000 },
    );

    const result = await sm.beginSession({
      role: 'custom-env-role',
      sessionId: 'sess-proxy-6',
    });

    const envContent = await fs.readFile(
      path.join(result.sessionDir, 'env'),
      'utf-8',
    );
    expect(envContent).toContain(`SENDGRID_API_URL=http://127.0.0.1:${PROXY_PORT}`);

    await sm.endSession('sess-proxy-6');
  });
});
