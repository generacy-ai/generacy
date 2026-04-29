import http from 'node:http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { matchAllowlist, LocalhostProxy } from '../../src/exposure/localhost-proxy.js';
import { CredhelperError } from '../../src/errors.js';
import type { ProxyRule } from '@generacy-ai/credhelper';

// --- T030: matchAllowlist unit tests ---

describe('matchAllowlist', () => {
  const rules: ProxyRule[] = [
    { method: 'POST', path: '/v3/mail/send' },
    { method: 'GET', path: '/v3/messages/{id}' },
    { method: 'DELETE', path: '/v3/messages/{id}/attachments/{attachmentId}' },
  ];

  it('matches a literal path with correct method', () => {
    expect(matchAllowlist('POST', '/v3/mail/send', rules)).toBe(true);
  });

  it('rejects wrong method for literal path', () => {
    expect(matchAllowlist('GET', '/v3/mail/send', rules)).toBe(false);
  });

  it('matches {param} placeholders', () => {
    expect(matchAllowlist('GET', '/v3/messages/abc123', rules)).toBe(true);
  });

  it('matches multiple {param} placeholders', () => {
    expect(matchAllowlist('DELETE', '/v3/messages/msg1/attachments/att2', rules)).toBe(true);
  });

  it('{param} does not match empty segment', () => {
    expect(matchAllowlist('GET', '/v3/messages/', rules)).toBe(false);
  });

  it('trailing slash is significant — /v3/mail/send/ does not match /v3/mail/send', () => {
    expect(matchAllowlist('POST', '/v3/mail/send/', rules)).toBe(false);
  });

  it('strips query string before matching', () => {
    expect(matchAllowlist('POST', '/v3/mail/send?foo=bar', rules)).toBe(true);
  });

  it('method matching is case-insensitive', () => {
    expect(matchAllowlist('post', '/v3/mail/send', rules)).toBe(true);
    expect(matchAllowlist('Post', '/v3/mail/send', rules)).toBe(true);
  });

  it('path matching is case-sensitive', () => {
    expect(matchAllowlist('POST', '/V3/Mail/Send', rules)).toBe(false);
  });

  it('rejects path with extra segments', () => {
    expect(matchAllowlist('POST', '/v3/mail/send/extra', rules)).toBe(false);
  });

  it('rejects path with fewer segments', () => {
    expect(matchAllowlist('POST', '/v3/mail', rules)).toBe(false);
  });

  it('rejects arbitrary path not in allowlist', () => {
    expect(matchAllowlist('GET', '/v3/unknown/endpoint', rules)).toBe(false);
  });

  it('returns false for empty rules', () => {
    expect(matchAllowlist('GET', '/anything', [])).toBe(false);
  });
});

// --- T031: proxy handler unit tests ---

describe('LocalhostProxy handler', () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let proxy: LocalhostProxy;
  const proxyPort = 19871;

  beforeEach(async () => {
    // Create a fake upstream server
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

    proxy = new LocalhostProxy({
      port: proxyPort,
      upstream: `http://127.0.0.1:${upstreamPort}`,
      headers: { Authorization: 'Bearer sk-secret-key' },
      allowlist: [
        { method: 'POST', path: '/v3/mail/send' },
        { method: 'GET', path: '/v3/messages/{id}' },
      ],
    });
    await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
  });

  function makeRequest(
    method: string,
    reqPath: string,
    body?: string,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: proxyPort, method, path: reqPath, agent: false },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
            });
          });
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  it('forwards allowed request with auth headers injected', async () => {
    const res = await makeRequest('POST', '/v3/mail/send', '{"to":"test@example.com"}');
    expect(res.statusCode).toBe(200);

    const data = JSON.parse(res.body);
    expect(data.receivedMethod).toBe('POST');
    expect(data.receivedPath).toBe('/v3/mail/send');
    expect(data.receivedAuth).toBe('Bearer sk-secret-key');
    expect(data.receivedBody).toBe('{"to":"test@example.com"}');
  });

  it('forwards allowed request with {param} placeholder', async () => {
    const res = await makeRequest('GET', '/v3/messages/msg-123');
    expect(res.statusCode).toBe(200);

    const data = JSON.parse(res.body);
    expect(data.receivedMethod).toBe('GET');
    expect(data.receivedPath).toBe('/v3/messages/msg-123');
    expect(data.receivedAuth).toBe('Bearer sk-secret-key');
  });

  it('returns 403 JSON for denied request', async () => {
    const res = await makeRequest('GET', '/v3/mail/send');
    expect(res.statusCode).toBe(403);

    const data = JSON.parse(res.body);
    expect(data.code).toBe('PROXY_ACCESS_DENIED');
    expect(data.details.method).toBe('GET');
    expect(data.details.path).toBe('/v3/mail/send');
  });

  it('returns 403 for arbitrary path', async () => {
    const res = await makeRequest('GET', '/v3/unknown');
    expect(res.statusCode).toBe(403);
    const data = JSON.parse(res.body);
    expect(data.code).toBe('PROXY_ACCESS_DENIED');
  });

  it('passes through upstream error status codes', async () => {
    // Close upstream to make it unreachable, then restart with 500 response
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });

    upstream = http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    });
    await new Promise<void>((resolve) => {
      upstream.listen(upstreamPort, '127.0.0.1', () => resolve());
    });

    const res = await makeRequest('POST', '/v3/mail/send');
    expect(res.statusCode).toBe(500);
    const data = JSON.parse(res.body);
    expect(data.error).toBe('Internal Server Error');
  });
});

// --- T032: port collision tests ---

describe('LocalhostProxy port collision', () => {
  let firstProxy: LocalhostProxy;
  const port = 19872;

  beforeEach(async () => {
    firstProxy = new LocalhostProxy({
      port,
      upstream: 'http://127.0.0.1:9999',
      headers: {},
      allowlist: [],
    });
    await firstProxy.start();
  });

  afterEach(async () => {
    await firstProxy.stop();
  });

  it('EADDRINUSE surfaces PROXY_PORT_COLLISION error', async () => {
    const secondProxy = new LocalhostProxy({
      port,
      upstream: 'http://127.0.0.1:9999',
      headers: {},
      allowlist: [],
    });

    await expect(secondProxy.start()).rejects.toThrow(CredhelperError);

    try {
      await secondProxy.start();
    } catch (err) {
      expect(err).toBeInstanceOf(CredhelperError);
      expect((err as CredhelperError).code).toBe('PROXY_PORT_COLLISION');
      expect((err as CredhelperError).details).toEqual({ port });
    }
  });
});
