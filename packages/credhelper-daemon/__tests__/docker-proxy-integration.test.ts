import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { DockerProxy } from '../src/docker-proxy.js';
import type { DockerProxyConfig } from '../src/types.js';

/** Create a fake upstream Docker daemon on a temp Unix socket. */
function createFakeUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
) {
  const socketPath = path.join(
    os.tmpdir(),
    `upstream-int-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
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
  requestPath: string,
  body?: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(body));
    }
    const req = http.request(
      { socketPath, method, path: requestPath, headers },
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

describe('Docker proxy integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-int-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('full session lifecycle: start proxy, allow/deny requests, stop proxy', async () => {
    // Create fake upstream
    const upstream = createFakeUpstream((req, res) => {
      if (req.url?.includes('/containers/json')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ Id: 'abc', Names: ['/test'] }]));
      } else if (req.url?.includes('/containers/create')) {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Id: 'new123' }));
      } else {
        res.writeHead(200);
        res.end('ok');
      }
    });
    await upstream.start();

    const sessionDir = path.join(tmpDir, 'session-int');
    await fs.mkdir(sessionDir, { recursive: true });
    const scratchDir = path.join(tmpDir, 'scratch');
    await fs.mkdir(scratchDir, { recursive: true });

    const config: DockerProxyConfig = {
      sessionId: 'integration-test',
      sessionDir,
      rules: [
        { method: 'GET', path: '/containers/json' },
        { method: 'POST', path: '/containers/create' },
      ],
      upstreamSocket: upstream.socketPath,
      upstreamIsHost: true,
      scratchDir,
    };

    const proxy = new DockerProxy(config);
    const socketPath = await proxy.start();

    try {
      // Verify socket was created
      const stat = await fs.stat(socketPath);
      expect(stat.isSocket()).toBe(true);

      // Allowed GET request succeeds
      const getRes = await makeRequest(socketPath, 'GET', '/containers/json');
      expect(getRes.statusCode).toBe(200);
      const containers = JSON.parse(getRes.body);
      expect(containers).toHaveLength(1);

      // Disallowed verb returns 403
      const deleteRes = await makeRequest(socketPath, 'DELETE', '/containers/abc');
      expect(deleteRes.statusCode).toBe(403);
      expect(JSON.parse(deleteRes.body).code).toBe('DOCKER_ACCESS_DENIED');

      // POST /containers/create with valid bind mount (under scratch) succeeds
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const validBody = JSON.stringify({
        Image: 'node:20',
        HostConfig: {
          Binds: [`${scratchDir}/workspace:/app`],
        },
      });
      const createRes = await makeRequest(socketPath, 'POST', '/containers/create', validBody);
      expect(createRes.statusCode).toBe(201);
      warnSpy.mockRestore();

      // POST /containers/create with invalid bind mount (outside scratch) is rejected
      const invalidBody = JSON.stringify({
        Image: 'node:20',
        HostConfig: {
          Binds: ['/etc/passwd:/etc/passwd:ro'],
        },
      });
      const rejectRes = await makeRequest(socketPath, 'POST', '/containers/create', invalidBody);
      expect(rejectRes.statusCode).toBe(403);
      expect(JSON.parse(rejectRes.body).code).toBe('DOCKER_ACCESS_DENIED');
      expect(JSON.parse(rejectRes.body).details.rejectedPaths).toContain('/etc/passwd');
    } finally {
      await proxy.stop();
      await upstream.stop();
    }

    // Socket file should be cleaned up after stop
    await expect(fs.stat(socketPath)).rejects.toThrow();
  });

  it('DinD mode skips bind-mount guard', async () => {
    const upstream = createFakeUpstream((_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Id: 'dind-ok' }));
    });
    await upstream.start();

    const sessionDir = path.join(tmpDir, 'session-dind');
    await fs.mkdir(sessionDir, { recursive: true });
    const scratchDir = path.join(tmpDir, 'scratch-dind');
    await fs.mkdir(scratchDir, { recursive: true });

    const config: DockerProxyConfig = {
      sessionId: 'dind-test',
      sessionDir,
      rules: [{ method: 'POST', path: '/containers/create' }],
      upstreamSocket: upstream.socketPath,
      upstreamIsHost: false, // DinD — no bind-mount guard
      scratchDir,
    };

    const proxy = new DockerProxy(config);
    await proxy.start();

    try {
      // Even mounts outside scratch dir should be allowed in DinD mode
      const body = JSON.stringify({
        Image: 'node:20',
        HostConfig: {
          Binds: ['/etc/passwd:/etc/passwd'],
        },
      });
      const res = await makeRequest(proxy.getSocketPath(), 'POST', '/containers/create', body);
      expect(res.statusCode).toBe(201);
    } finally {
      await proxy.stop();
      await upstream.stop();
    }
  });

  it('proxy without scratchDir skips bind-mount guard on host socket', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const upstream = createFakeUpstream((_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Id: 'noscratch' }));
    });
    await upstream.start();

    const sessionDir = path.join(tmpDir, 'session-noscratch');
    await fs.mkdir(sessionDir, { recursive: true });

    const config: DockerProxyConfig = {
      sessionId: 'noscratch-test',
      sessionDir,
      rules: [{ method: 'POST', path: '/containers/create' }],
      upstreamSocket: upstream.socketPath,
      upstreamIsHost: true,
      // no scratchDir — guard should be skipped
    };

    const proxy = new DockerProxy(config);
    await proxy.start();

    try {
      const body = JSON.stringify({
        Image: 'node:20',
        HostConfig: {
          Binds: ['/etc/passwd:/etc/passwd'],
        },
      });
      const res = await makeRequest(proxy.getSocketPath(), 'POST', '/containers/create', body);
      // Without scratchDir, bind-mount guard is not active, so request passes through
      expect(res.statusCode).toBe(201);
    } finally {
      warnSpy.mockRestore();
      await proxy.stop();
      await upstream.stop();
    }
  });
});
