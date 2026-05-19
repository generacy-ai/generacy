import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { activate, buildActivationUrl } from '../index.js';
import { ActivationError } from '../errors.js';
import { NativeHttpClient } from '../client.js';
import { writeKeyFile, writeClusterJson } from '../persistence.js';
import type { Logger } from 'pino';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

interface FakeCloudState {
  pollCount: number;
  approveAfter: number;
  slowDownAt?: number;
  expireAt?: number;
}

function createFakeCloudServer(state: FakeCloudState): http.Server {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/api/clusters/device-code' && req.method === 'POST') {
        res.end(JSON.stringify({
          device_code: 'dc_fake_123',
          user_code: 'TEST-CODE',
          verification_uri: 'https://generacy.ai/cluster-activate',
          interval: 1,
          expires_in: 30,
        }));
        return;
      }

      if (req.url === '/api/clusters/device-code/poll' && req.method === 'POST') {
        state.pollCount++;

        if (state.slowDownAt && state.pollCount === state.slowDownAt) {
          res.end(JSON.stringify({ status: 'slow_down' }));
          return;
        }

        if (state.expireAt && state.pollCount >= state.expireAt) {
          res.end(JSON.stringify({ status: 'expired' }));
          return;
        }

        if (state.pollCount >= state.approveAfter) {
          res.end(JSON.stringify({
            status: 'approved',
            cluster_api_key: 'secret_key_never_log_this',
            cluster_api_key_id: 'kid_abc',
            cluster_id: 'cluster_test_1',
            project_id: 'proj_test_1',
            org_id: 'org_test_1',
          }));
          return;
        }

        res.end(JSON.stringify({ status: 'authorization_pending' }));
      }
    });
  });
}

describe('activate (integration)', () => {
  let tempDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'activation-integration-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function startServer(state: FakeCloudState): Promise<void> {
    server = createFakeCloudServer(state);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  it('full happy path: device-code -> poll -> approved -> persisted', async () => {
    await startServer({ pollCount: 0, approveAfter: 2 });

    const keyFilePath = join(tempDir, 'cluster-api-key');
    const clusterJsonPath = join(tempDir, 'cluster.json');

    const result = await activate({
      cloudUrl: baseUrl,
      keyFilePath,
      clusterJsonPath,
      logger: createMockLogger(),
      httpClient: new NativeHttpClient(),
    });

    expect(result.apiKey).toBe('secret_key_never_log_this');
    expect(result.clusterApiKeyId).toBe('kid_abc');
    expect(result.clusterId).toBe('cluster_test_1');
    expect(result.projectId).toBe('proj_test_1');
    expect(result.orgId).toBe('org_test_1');

    // Verify persistence
    const savedKey = await readFile(keyFilePath, 'utf-8');
    expect(savedKey).toBe('secret_key_never_log_this');

    const savedJson = JSON.parse(await readFile(clusterJsonPath, 'utf-8'));
    expect(savedJson.cluster_id).toBe('cluster_test_1');
    expect(savedJson.cloud_url).toBe(baseUrl);
  });

  it('slow_down path increases poll interval', async () => {
    await startServer({ pollCount: 0, approveAfter: 3, slowDownAt: 1 });

    const logger = createMockLogger();
    const result = await activate({
      cloudUrl: baseUrl,
      keyFilePath: join(tempDir, 'key'),
      clusterJsonPath: join(tempDir, 'cluster.json'),
      logger,
      httpClient: new NativeHttpClient(),
    });

    expect(result.status).toBeUndefined(); // no status field on ActivationResult
    expect(result.apiKey).toBe('secret_key_never_log_this');
    // Verify slow_down was logged
    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const hasSlowDown = infoCalls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('interval'),
    );
    expect(hasSlowDown).toBe(true);
  });

  it('expired + auto-retry path', async () => {
    // Server will expire on poll 2, then approve on next cycle's poll 1
    let cycle = 0;
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');

        if (req.url === '/api/clusters/device-code') {
          cycle++;
          res.end(JSON.stringify({
            device_code: `dc_cycle_${cycle}`,
            user_code: `CODE-${cycle}`,
            verification_uri: 'https://generacy.ai/cluster-activate',
            interval: 1,
            expires_in: 10,
          }));
          return;
        }

        if (req.url === '/api/clusters/device-code/poll') {
          if (cycle === 1) {
            res.end(JSON.stringify({ status: 'expired' }));
          } else {
            res.end(JSON.stringify({
              status: 'approved',
              cluster_api_key: 'key_after_retry',
              cluster_api_key_id: 'kid_retry',
              cluster_id: 'cluster_retry',
              project_id: 'proj_retry',
              org_id: 'org_retry',
            }));
          }
          return;
        }

        res.statusCode = 404;
        res.end('{}');
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const logger = createMockLogger();
    const result = await activate({
      cloudUrl: baseUrl,
      keyFilePath: join(tempDir, 'key'),
      clusterJsonPath: join(tempDir, 'cluster.json'),
      logger,
      maxCycles: 3,
      httpClient: new NativeHttpClient(),
    });

    expect(result.apiKey).toBe('key_after_retry');
    expect(cycle).toBe(2);
  });

  it('existing key file skips activation', async () => {
    const keyFilePath = join(tempDir, 'existing-key');
    const clusterJsonPath = join(tempDir, 'cluster.json');

    await writeKeyFile(keyFilePath, 'existing-api-key');
    await writeClusterJson(clusterJsonPath, {
      cluster_id: 'existing_cluster',
      project_id: 'existing_proj',
      org_id: 'existing_org',
      cloud_url: 'https://api.generacy.ai',
      activated_at: '2024-01-01T00:00:00.000Z',
    });

    const logger = createMockLogger();
    const result = await activate({
      cloudUrl: 'https://should-not-be-called.example.com',
      keyFilePath,
      clusterJsonPath,
      logger,
      httpClient: new NativeHttpClient(),
    });

    expect(result.apiKey).toBe('existing-api-key');
    expect(result.clusterId).toBe('existing_cluster');
    // No HTTP calls should have been made
    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const hasSkipMessage = infoCalls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('skipping activation'),
    );
    expect(hasSkipMessage).toBe(true);
  });

  it('API key never appears in log output', async () => {
    await startServer({ pollCount: 0, approveAfter: 1 });

    const logger = createMockLogger();
    await activate({
      cloudUrl: baseUrl,
      keyFilePath: join(tempDir, 'key'),
      clusterJsonPath: join(tempDir, 'cluster.json'),
      logger,
      httpClient: new NativeHttpClient(),
    });

    // Check all log calls for the secret key
    const allCalls = [
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.debug as ReturnType<typeof vi.fn>).mock.calls,
    ];

    for (const call of allCalls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain('secret_key_never_log_this');
    }
  });
});

describe('buildActivationUrl', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['GENERACY_PROJECT_ID'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('appends code param to verification_uri', () => {
    const result = buildActivationUrl('https://app.generacy.ai/cluster-activate', 'ABCD-1234');
    const url = new URL(result);
    expect(url.searchParams.get('code')).toBe('ABCD-1234');
    expect(url.searchParams.has('projectId')).toBe(false);
  });

  it('appends projectId when GENERACY_PROJECT_ID is set', () => {
    process.env['GENERACY_PROJECT_ID'] = 'proj_abc123';
    const result = buildActivationUrl('https://app.generacy.ai/cluster-activate', 'ABCD-1234');
    const url = new URL(result);
    expect(url.searchParams.get('code')).toBe('ABCD-1234');
    expect(url.searchParams.get('projectId')).toBe('proj_abc123');
  });

  it('omits projectId when GENERACY_PROJECT_ID is unset', () => {
    const result = buildActivationUrl('https://app.generacy.ai/cluster-activate', 'TEST-CODE');
    const url = new URL(result);
    expect(url.searchParams.get('code')).toBe('TEST-CODE');
    expect(url.searchParams.has('projectId')).toBe(false);
  });

  it('merges with existing query params on verification_uri', () => {
    const result = buildActivationUrl('https://app.generacy.ai/cluster-activate?existing=value', 'CODE-99');
    const url = new URL(result);
    expect(url.searchParams.get('existing')).toBe('value');
    expect(url.searchParams.get('code')).toBe('CODE-99');
  });

  it('handles verification_uri with trailing slash', () => {
    const result = buildActivationUrl('https://app.generacy.ai/cluster-activate/', 'SLASH-01');
    const url = new URL(result);
    expect(url.pathname).toBe('/cluster-activate/');
    expect(url.searchParams.get('code')).toBe('SLASH-01');
  });
});
