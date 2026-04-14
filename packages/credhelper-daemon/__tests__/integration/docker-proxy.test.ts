import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { DockerProxy } from '../../src/docker-proxy.js';
import type { DockerRule } from '../../src/types.js';

/** Send a request to a Unix socket and get the response. */
function makeRequest(
  socketPath: string,
  method: string,
  reqPath: string,
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, method, path: reqPath },
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
    req.end();
  });
}

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

describe('Docker Proxy Integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-proxy-int-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('full lifecycle: start → allowed request → denied request → stop → cleanup', async () => {
    // Set up a fake upstream that responds to container list
    const upstream = createFakeUpstream((req, res) => {
      if (req.url?.includes('/containers/json')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ Id: 'abc123', Names: ['/test-container'] }]));
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    await upstream.start();

    const rules: DockerRule[] = [
      { method: 'GET', path: '/containers/json' },
      { method: 'GET', path: '/containers/{id}/json' },
    ];

    const proxy = new DockerProxy({
      sessionId: 'test-session-001',
      sessionDir: tmpDir,
      rules,
      upstreamSocket: upstream.socketPath,
      upstreamIsHost: false,
    });

    try {
      // Start the proxy
      const socketPath = await proxy.start();
      expect(socketPath).toBe(path.join(tmpDir, 'docker.sock'));

      // Verify socket file exists
      const stat = await fs.stat(socketPath);
      expect(stat.isSocket()).toBe(true);

      // Send an allowed request → should forward to upstream
      const allowedRes = await makeRequest(socketPath, 'GET', '/containers/json');
      expect(allowedRes.statusCode).toBe(200);
      const body = JSON.parse(allowedRes.body);
      expect(body).toEqual([{ Id: 'abc123', Names: ['/test-container'] }]);

      // Send a denied request → should return 403
      const deniedRes = await makeRequest(socketPath, 'POST', '/containers/create');
      expect(deniedRes.statusCode).toBe(403);
      const denyBody = JSON.parse(deniedRes.body);
      expect(denyBody.code).toBe('DOCKER_ACCESS_DENIED');
      expect(denyBody.error).toContain('POST');
      expect(denyBody.error).toContain('/containers/create');

      // Stop the proxy
      await proxy.stop();

      // Verify socket file is removed
      await expect(fs.stat(socketPath)).rejects.toThrow();
    } finally {
      await upstream.stop();
    }
  });

  it('container name filtering: allows matching name, denies non-matching', async () => {
    // Upstream returns container info with name
    const upstream = createFakeUpstream((req, res) => {
      const url = req.url ?? '';
      if (url.includes('/containers/firebase-abc/json')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Name: '/firebase-emulator' }));
      } else if (url.includes('/containers/redis-xyz/json')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Name: '/redis' }));
      } else if (url.includes('/start')) {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await upstream.start();

    const rules: DockerRule[] = [
      { method: 'POST', path: '/containers/{id}/start', name: 'firebase-*' },
    ];

    const proxy = new DockerProxy({
      sessionId: 'test-session-002',
      sessionDir: tmpDir,
      rules,
      upstreamSocket: upstream.socketPath,
      upstreamIsHost: false,
    });

    try {
      const socketPath = await proxy.start();

      // Start a firebase container → allowed (name matches glob)
      const allowedRes = await makeRequest(socketPath, 'POST', '/containers/firebase-abc/start');
      expect(allowedRes.statusCode).toBe(204);

      // Start a redis container → denied (name doesn't match glob)
      const deniedRes = await makeRequest(socketPath, 'POST', '/containers/redis-xyz/start');
      expect(deniedRes.statusCode).toBe(403);

      await proxy.stop();
    } finally {
      await upstream.stop();
    }
  });

  it('version prefix is stripped for matching but forwarded to upstream', async () => {
    let receivedUrl = '';
    const upstream = createFakeUpstream((req, res) => {
      receivedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });
    await upstream.start();

    const rules: DockerRule[] = [
      { method: 'GET', path: '/containers/json' },
    ];

    const proxy = new DockerProxy({
      sessionId: 'test-session-003',
      sessionDir: tmpDir,
      rules,
      upstreamSocket: upstream.socketPath,
      upstreamIsHost: false,
    });

    try {
      const socketPath = await proxy.start();

      const res = await makeRequest(socketPath, 'GET', '/v1.41/containers/json');
      expect(res.statusCode).toBe(200);
      // Upstream should receive the original versioned URL
      expect(receivedUrl).toBe('/v1.41/containers/json');

      await proxy.stop();
    } finally {
      await upstream.stop();
    }
  });
});
