import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { createDockerProxyHandler } from '../src/docker-proxy-handler.js';
import { ContainerNameResolver } from '../src/docker-name-resolver.js';

/** Create a fake upstream Docker server on a temp Unix socket. */
function createFakeUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
) {
  const socketPath = path.join(
    os.tmpdir(),
    `upstream-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
  const server = http.createServer(handler);

  return {
    server,
    socketPath,
    start: () =>
      new Promise<void>((resolve, reject) => {
        server.on('error', reject);
        server.listen(socketPath, () => resolve());
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          fs.unlink(socketPath).catch(() => {}).then(() => resolve());
        });
      }),
  };
}

/** Create a proxy server with the given handler on a temp Unix socket. */
function createProxyServer(handler: http.RequestListener) {
  const socketPath = path.join(
    os.tmpdir(),
    `proxy-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
  const server = http.createServer(handler);

  return {
    server,
    socketPath,
    start: () =>
      new Promise<void>((resolve, reject) => {
        server.on('error', reject);
        server.listen(socketPath, () => resolve());
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          fs.unlink(socketPath).catch(() => {}).then(() => resolve());
        });
      }),
  };
}

/** Send a request to a Unix socket and get the response. */
function makeRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: string,
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(body));
    }
    const req = http.request(
      { socketPath, method, path, headers },
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
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

describe('createDockerProxyHandler', () => {
  describe('allowed request forwards', () => {
    it('forwards an allowed GET request to upstream and relays the response', async () => {
      const upstream = createFakeUpstream((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ Id: 'abc123', Names: ['/test'] }]));
      });
      await upstream.start();

      const handler = createDockerProxyHandler({
        rules: [{ method: 'GET', path: '/containers/json' }],
        upstreamSocket: upstream.socketPath,
        upstreamIsHost: false,
        nameResolver: new ContainerNameResolver(upstream.socketPath),
      });
      const proxy = createProxyServer(handler);
      await proxy.start();

      try {
        const res = await makeRequest(proxy.socketPath, 'GET', '/containers/json');
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body).toEqual([{ Id: 'abc123', Names: ['/test'] }]);
      } finally {
        await proxy.stop();
        await upstream.stop();
      }
    });
  });

  describe('denied request returns 403', () => {
    it('returns 403 with DOCKER_ACCESS_DENIED for a request not in the allowlist', async () => {
      const upstream = createFakeUpstream((_req, res) => {
        res.writeHead(200);
        res.end('should not reach here');
      });
      await upstream.start();

      const handler = createDockerProxyHandler({
        rules: [{ method: 'GET', path: '/containers/json' }],
        upstreamSocket: upstream.socketPath,
        upstreamIsHost: false,
        nameResolver: new ContainerNameResolver(upstream.socketPath),
      });
      const proxy = createProxyServer(handler);
      await proxy.start();

      try {
        const res = await makeRequest(proxy.socketPath, 'POST', '/containers/create');
        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('DOCKER_ACCESS_DENIED');
        expect(body.error).toContain('POST');
        expect(body.error).toContain('/containers/create');
      } finally {
        await proxy.stop();
        await upstream.stop();
      }
    });
  });

  describe('version prefix stripped', () => {
    it('strips /v1.41 prefix before matching and forwards to upstream with original URL', async () => {
      let upstreamPath = '';
      const upstream = createFakeUpstream((req, res) => {
        upstreamPath = req.url ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      });
      await upstream.start();

      const handler = createDockerProxyHandler({
        rules: [{ method: 'GET', path: '/containers/json' }],
        upstreamSocket: upstream.socketPath,
        upstreamIsHost: false,
        nameResolver: new ContainerNameResolver(upstream.socketPath),
      });
      const proxy = createProxyServer(handler);
      await proxy.start();

      try {
        const res = await makeRequest(proxy.socketPath, 'GET', '/v1.41/containers/json');
        expect(res.statusCode).toBe(200);
        // The original versioned URL should be forwarded to upstream
        expect(upstreamPath).toBe('/v1.41/containers/json');
      } finally {
        await proxy.stop();
        await upstream.stop();
      }
    });
  });

  describe('follow=true rejected', () => {
    it('returns 403 when logs endpoint has follow=true', async () => {
      const upstream = createFakeUpstream((_req, res) => {
        res.writeHead(200);
        res.end('should not reach');
      });
      await upstream.start();

      const handler = createDockerProxyHandler({
        rules: [{ method: 'GET', path: '/containers/{id}/logs' }],
        upstreamSocket: upstream.socketPath,
        upstreamIsHost: false,
        nameResolver: new ContainerNameResolver(upstream.socketPath),
      });
      const proxy = createProxyServer(handler);
      await proxy.start();

      try {
        const res = await makeRequest(
          proxy.socketPath,
          'GET',
          '/containers/abc123/logs?follow=true&stdout=true',
        );
        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('DOCKER_ACCESS_DENIED');
      } finally {
        await proxy.stop();
        await upstream.stop();
      }
    });

    it('allows logs endpoint without follow=true', async () => {
      const upstream = createFakeUpstream((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end('log output here');
      });
      await upstream.start();

      const handler = createDockerProxyHandler({
        rules: [{ method: 'GET', path: '/containers/{id}/logs' }],
        upstreamSocket: upstream.socketPath,
        upstreamIsHost: false,
        nameResolver: new ContainerNameResolver(upstream.socketPath),
      });
      const proxy = createProxyServer(handler);
      await proxy.start();

      try {
        const res = await makeRequest(
          proxy.socketPath,
          'GET',
          '/containers/abc123/logs?stdout=true',
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe('log output here');
      } finally {
        await proxy.stop();
        await upstream.stop();
      }
    });
  });

  describe('chunked response relay', () => {
    it('relays chunked transfer encoding from upstream', async () => {
      const upstream = createFakeUpstream((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        });
        res.write('{"chunk":');
        setTimeout(() => {
          res.end('"data"}');
        }, 10);
      });
      await upstream.start();

      const handler = createDockerProxyHandler({
        rules: [{ method: 'GET', path: '/containers/json' }],
        upstreamSocket: upstream.socketPath,
        upstreamIsHost: false,
        nameResolver: new ContainerNameResolver(upstream.socketPath),
      });
      const proxy = createProxyServer(handler);
      await proxy.start();

      try {
        const res = await makeRequest(proxy.socketPath, 'GET', '/containers/json');
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body).toEqual({ chunk: 'data' });
      } finally {
        await proxy.stop();
        await upstream.stop();
      }
    });
  });

  describe('dangerous path logged', () => {
    it('logs a security warning when forwarding POST /containers/create on host socket', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const upstream = createFakeUpstream((_req, res) => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Id: 'new123' }));
      });
      await upstream.start();

      const handler = createDockerProxyHandler({
        rules: [{ method: 'POST', path: '/containers/create' }],
        upstreamSocket: upstream.socketPath,
        upstreamIsHost: true, // host socket
        nameResolver: new ContainerNameResolver(upstream.socketPath),
      });
      const proxy = createProxyServer(handler);
      await proxy.start();

      try {
        await makeRequest(proxy.socketPath, 'POST', '/containers/create');
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('SECURITY: forwarding POST /containers/create to host Docker socket'),
        );
      } finally {
        warnSpy.mockRestore();
        await proxy.stop();
        await upstream.stop();
      }
    });

    it('does NOT log security warning when upstreamIsHost is false', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const upstream = createFakeUpstream((_req, res) => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Id: 'new123' }));
      });
      await upstream.start();

      const handler = createDockerProxyHandler({
        rules: [{ method: 'POST', path: '/containers/create' }],
        upstreamSocket: upstream.socketPath,
        upstreamIsHost: false, // DinD, not host
        nameResolver: new ContainerNameResolver(upstream.socketPath),
      });
      const proxy = createProxyServer(handler);
      await proxy.start();

      try {
        await makeRequest(proxy.socketPath, 'POST', '/containers/create');
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
        await proxy.stop();
        await upstream.stop();
      }
    });
  });

  describe('bind-mount guard (host-socket mode)', () => {
    const scratchDir = '/var/lib/generacy/scratch/session-test';

    it('blocks POST /containers/create with bind mounts outside scratch dir', async () => {
      const upstream = createFakeUpstream((_req, res) => {
        res.writeHead(201);
        res.end(JSON.stringify({ Id: 'bad' }));
      });
      await upstream.start();

      const handler = createDockerProxyHandler({
        rules: [{ method: 'POST', path: '/containers/create' }],
        upstreamSocket: upstream.socketPath,
        upstreamIsHost: true,
        nameResolver: new ContainerNameResolver(upstream.socketPath),
        scratchDir,
      });
      const proxy = createProxyServer(handler);
      await proxy.start();

      try {
        const body = JSON.stringify({
          Image: 'node:20',
          HostConfig: {
            Binds: ['/etc/passwd:/etc/passwd:ro'],
          },
        });
        const res = await makeRequest(proxy.socketPath, 'POST', '/containers/create', body);
        expect(res.statusCode).toBe(403);
        const parsed = JSON.parse(res.body);
        expect(parsed.code).toBe('DOCKER_ACCESS_DENIED');
        expect(parsed.details.rejectedPaths).toContain('/etc/passwd');
      } finally {
        await proxy.stop();
        await upstream.stop();
      }
    });

    it('allows POST /containers/create with bind mounts under scratch dir', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const upstream = createFakeUpstream((_req, res) => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Id: 'good123' }));
      });
      await upstream.start();

      const handler = createDockerProxyHandler({
        rules: [{ method: 'POST', path: '/containers/create' }],
        upstreamSocket: upstream.socketPath,
        upstreamIsHost: true,
        nameResolver: new ContainerNameResolver(upstream.socketPath),
        scratchDir,
      });
      const proxy = createProxyServer(handler);
      await proxy.start();

      try {
        const body = JSON.stringify({
          Image: 'node:20',
          HostConfig: {
            Binds: [`${scratchDir}/workspace:/app`],
          },
        });
        const res = await makeRequest(proxy.socketPath, 'POST', '/containers/create', body);
        expect(res.statusCode).toBe(201);
        const parsed = JSON.parse(res.body);
        expect(parsed.Id).toBe('good123');
      } finally {
        warnSpy.mockRestore();
        await proxy.stop();
        await upstream.stop();
      }
    });

    it('skips bind-mount guard in DinD mode (upstreamIsHost=false)', async () => {
      const upstream = createFakeUpstream((_req, res) => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Id: 'dind123' }));
      });
      await upstream.start();

      const handler = createDockerProxyHandler({
        rules: [{ method: 'POST', path: '/containers/create' }],
        upstreamSocket: upstream.socketPath,
        upstreamIsHost: false, // DinD
        nameResolver: new ContainerNameResolver(upstream.socketPath),
        scratchDir,
      });
      const proxy = createProxyServer(handler);
      await proxy.start();

      try {
        const body = JSON.stringify({
          Image: 'node:20',
          HostConfig: {
            Binds: ['/etc/passwd:/etc/passwd'],
          },
        });
        const res = await makeRequest(proxy.socketPath, 'POST', '/containers/create', body);
        expect(res.statusCode).toBe(201);
      } finally {
        await proxy.stop();
        await upstream.stop();
      }
    });

    it('allows non-create requests through without body inspection', async () => {
      const upstream = createFakeUpstream((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      });
      await upstream.start();

      const handler = createDockerProxyHandler({
        rules: [{ method: 'GET', path: '/containers/json' }],
        upstreamSocket: upstream.socketPath,
        upstreamIsHost: true,
        nameResolver: new ContainerNameResolver(upstream.socketPath),
        scratchDir,
      });
      const proxy = createProxyServer(handler);
      await proxy.start();

      try {
        const res = await makeRequest(proxy.socketPath, 'GET', '/containers/json');
        expect(res.statusCode).toBe(200);
      } finally {
        await proxy.stop();
        await upstream.stop();
      }
    });

    it('rejects body exceeding size limit', async () => {
      const upstream = createFakeUpstream((_req, res) => {
        res.writeHead(201);
        res.end('{}');
      });
      await upstream.start();

      const handler = createDockerProxyHandler({
        rules: [{ method: 'POST', path: '/containers/create' }],
        upstreamSocket: upstream.socketPath,
        upstreamIsHost: true,
        nameResolver: new ContainerNameResolver(upstream.socketPath),
        scratchDir,
      });
      const proxy = createProxyServer(handler);
      await proxy.start();

      try {
        // Send a very large body — the default limit is 10MB, so we use a moderate
        // oversized payload that triggers the stream-based limit
        const body = 'x'.repeat(11 * 1024 * 1024);
        const res = await makeRequest(proxy.socketPath, 'POST', '/containers/create', body);
        expect(res.statusCode).toBe(403);
      } finally {
        await proxy.stop();
        await upstream.stop();
      }
    });
  });
});
