import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCloudPullClient } from '../../src/services/cloud-pull-client.js';
import { GitHelperError } from '../../src/types/git-token.js';

interface FakeServerHandle {
  url: string;
  close: () => Promise<void>;
}

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<FakeServerHandle> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function staticApiKeyReader(value: string | (() => Promise<string>)) {
  return {
    read: typeof value === 'function' ? value : async () => value,
  };
}

const futureIso = () => new Date(Date.now() + 60 * 60_000).toISOString();
const pastIso = () => new Date(Date.now() - 60_000).toISOString();

describe('createCloudPullClient', () => {
  let server: FakeServerHandle | undefined;

  beforeEach(() => {
    delete process.env['GENERACY_API_URL'];
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    delete process.env['GENERACY_API_URL'];
  });

  it('happy path: returns CloudPullResponse on 200 + valid body', async () => {
    server = await startServer((req, res) => {
      expect(req.headers['authorization']).toBe('Bearer test-cluster-key');
      expect(req.headers['content-type']).toBe('application/json');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: 'ghs_test_xxx', expiresAt: futureIso() }));
    });
    process.env['GENERACY_API_URL'] = server.url;

    const client = createCloudPullClient({
      apiKeyReader: staticApiKeyReader('test-cluster-key'),
    });

    const result = await client.pull('github-app');

    expect(result.token).toBe('ghs_test_xxx');
    expect(typeof result.expiresAt).toBe('string');
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('ECONNREFUSED → CLOUD_UNREACHABLE', async () => {
    // Pick a port we won't listen on. 1 is reserved; using a high unprivileged port is safer.
    process.env['GENERACY_API_URL'] = 'http://127.0.0.1:1';
    const client = createCloudPullClient({
      apiKeyReader: staticApiKeyReader('k'),
    });

    await expect(client.pull('github-app')).rejects.toMatchObject({
      code: 'CLOUD_UNREACHABLE',
    });
  });

  it('HTTP 401 → CLOUD_AUTH_REJECTED', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'nope' }));
    });
    process.env['GENERACY_API_URL'] = server.url;

    const client = createCloudPullClient({ apiKeyReader: staticApiKeyReader('k') });
    await expect(client.pull('github-app')).rejects.toMatchObject({
      code: 'CLOUD_AUTH_REJECTED',
    });
  });

  it('HTTP 403 → CLOUD_AUTH_REJECTED', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(403);
      res.end('');
    });
    process.env['GENERACY_API_URL'] = server.url;
    const client = createCloudPullClient({ apiKeyReader: staticApiKeyReader('k') });
    await expect(client.pull('github-app')).rejects.toMatchObject({
      code: 'CLOUD_AUTH_REJECTED',
    });
  });

  it('HTTP 400 → CLOUD_REQUEST_INVALID', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(400);
      res.end('bad');
    });
    process.env['GENERACY_API_URL'] = server.url;
    const client = createCloudPullClient({ apiKeyReader: staticApiKeyReader('k') });
    await expect(client.pull('github-app')).rejects.toMatchObject({
      code: 'CLOUD_REQUEST_INVALID',
    });
  });

  it('HTTP 500 → CLOUD_UPSTREAM_ERROR', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    process.env['GENERACY_API_URL'] = server.url;
    const client = createCloudPullClient({ apiKeyReader: staticApiKeyReader('k') });
    await expect(client.pull('github-app')).rejects.toMatchObject({
      code: 'CLOUD_UPSTREAM_ERROR',
    });
  });

  it('200 + malformed body → CLOUD_RESPONSE_INVALID', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not-json}');
    });
    process.env['GENERACY_API_URL'] = server.url;
    const client = createCloudPullClient({ apiKeyReader: staticApiKeyReader('k') });
    await expect(client.pull('github-app')).rejects.toMatchObject({
      code: 'CLOUD_RESPONSE_INVALID',
    });
  });

  it('200 + body missing fields → CLOUD_RESPONSE_INVALID', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: '' }));
    });
    process.env['GENERACY_API_URL'] = server.url;
    const client = createCloudPullClient({ apiKeyReader: staticApiKeyReader('k') });
    await expect(client.pull('github-app')).rejects.toMatchObject({
      code: 'CLOUD_RESPONSE_INVALID',
    });
  });

  it('200 + past expiresAt → CLOUD_RESPONSE_INVALID', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: 'ghs_x', expiresAt: pastIso() }));
    });
    process.env['GENERACY_API_URL'] = server.url;
    const client = createCloudPullClient({ apiKeyReader: staticApiKeyReader('k') });
    await expect(client.pull('github-app')).rejects.toMatchObject({
      code: 'CLOUD_RESPONSE_INVALID',
    });
  });

  it('missing API key → CLUSTER_API_KEY_MISSING', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: 'x', expiresAt: futureIso() }));
    });
    process.env['GENERACY_API_URL'] = server.url;

    const client = createCloudPullClient({
      apiKeyReader: staticApiKeyReader(async () => {
        throw new GitHelperError('CLUSTER_API_KEY_MISSING', 'missing');
      }),
    });

    await expect(client.pull('github-app')).rejects.toMatchObject({
      code: 'CLUSTER_API_KEY_MISSING',
    });
  });
});
