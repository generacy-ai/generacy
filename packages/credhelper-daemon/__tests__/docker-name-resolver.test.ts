import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

import { ContainerNameResolver } from '../src/docker-name-resolver.js';

/**
 * Helper: create a fake Docker API server on a temporary Unix socket
 * that responds to GET /containers/{id}/json.
 */
function createFakeDockerServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): { server: http.Server; socketPath: string; start: () => Promise<void>; stop: () => Promise<void> } {
  const socketPath = path.join(os.tmpdir(), `docker-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
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

describe('ContainerNameResolver', () => {
  describe('successful resolution', () => {
    it('resolves a container ID to its name', async () => {
      const fake = createFakeDockerServer((req, res) => {
        if (req.url === '/containers/abc123/json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Name: '/firebase-emulator' }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await fake.start();

      try {
        const resolver = new ContainerNameResolver(fake.socketPath);
        const name = await resolver.resolve('abc123');
        expect(name).toBe('firebase-emulator');
      } finally {
        await fake.stop();
      }
    });

    it('strips leading slash from container name', async () => {
      const fake = createFakeDockerServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Name: '/my-container' }));
      });
      await fake.start();

      try {
        const resolver = new ContainerNameResolver(fake.socketPath);
        const name = await resolver.resolve('xyz');
        expect(name).toBe('my-container');
      } finally {
        await fake.stop();
      }
    });
  });

  describe('cache hit', () => {
    it('returns cached result without hitting the server again', async () => {
      let requestCount = 0;
      const fake = createFakeDockerServer((_req, res) => {
        requestCount++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Name: '/cached-container' }));
      });
      await fake.start();

      try {
        const resolver = new ContainerNameResolver(fake.socketPath);

        const first = await resolver.resolve('abc123');
        const second = await resolver.resolve('abc123');

        expect(first).toBe('cached-container');
        expect(second).toBe('cached-container');
        expect(requestCount).toBe(1);
      } finally {
        await fake.stop();
      }
    });
  });

  describe('resolution failure', () => {
    it('returns null when upstream returns 404', async () => {
      const fake = createFakeDockerServer((_req, res) => {
        res.writeHead(404);
        res.end(JSON.stringify({ message: 'No such container' }));
      });
      await fake.start();

      try {
        const resolver = new ContainerNameResolver(fake.socketPath);
        const name = await resolver.resolve('nonexistent');
        expect(name).toBeNull();
      } finally {
        await fake.stop();
      }
    });

    it('returns null when upstream returns invalid JSON', async () => {
      const fake = createFakeDockerServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('not json');
      });
      await fake.start();

      try {
        const resolver = new ContainerNameResolver(fake.socketPath);
        const name = await resolver.resolve('badjson');
        expect(name).toBeNull();
      } finally {
        await fake.stop();
      }
    });

    it('returns null when upstream socket does not exist', async () => {
      const resolver = new ContainerNameResolver('/tmp/nonexistent-docker.sock');
      const name = await resolver.resolve('anything');
      expect(name).toBeNull();
    });
  });

  describe('cache clear', () => {
    it('clears the cache so subsequent resolves hit the server again', async () => {
      let requestCount = 0;
      const fake = createFakeDockerServer((_req, res) => {
        requestCount++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Name: '/container-name' }));
      });
      await fake.start();

      try {
        const resolver = new ContainerNameResolver(fake.socketPath);

        await resolver.resolve('abc');
        expect(requestCount).toBe(1);

        resolver.clear();

        await resolver.resolve('abc');
        expect(requestCount).toBe(2);
      } finally {
        await fake.stop();
      }
    });
  });
});
