import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerEngineClient } from '../../src/services/docker-engine-client.js';
import {
  DockerDaemonUnavailableError,
  DockerEngineError,
} from '../../src/services/docker-engine-types.js';

type CapturedRequest = {
  method: string;
  url: string;
  body: string;
  headers: http.IncomingHttpHeaders;
};

interface FakeRouteResponse {
  statusCode: number;
  body?: string | object;
}

type FakeRouteHandler = (req: CapturedRequest) => FakeRouteResponse;

interface FakeServer {
  server: http.Server;
  socketPath: string;
  requests: CapturedRequest[];
  setHandler(handler: FakeRouteHandler): void;
  close(): Promise<void>;
}

async function startFakeEngine(): Promise<FakeServer> {
  const tempDir = mkdtempSync(join(tmpdir(), 'docker-engine-test-'));
  const socketPath = join(tempDir, 'docker.sock');
  const requests: CapturedRequest[] = [];
  let handler: FakeRouteHandler = () => ({ statusCode: 200, body: {} });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        body,
        headers: req.headers,
      };
      requests.push(captured);
      const result = handler(captured);
      res.statusCode = result.statusCode;
      if (typeof result.body === 'string') {
        res.end(result.body);
      } else if (result.body === undefined) {
        res.end();
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(result.body));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  return {
    server,
    socketPath,
    requests,
    setHandler(h) {
      handler = h;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe('DockerEngineClient', () => {
  let fake: FakeServer;
  let client: DockerEngineClient;

  beforeEach(async () => {
    fake = await startFakeEngine();
    client = new DockerEngineClient({ dockerHost: `unix://${fake.socketPath}` });
  });

  afterEach(async () => {
    await fake.close();
  });

  describe('listContainers', () => {
    it('builds URL with all=true and JSON-encoded label filters', async () => {
      fake.setHandler(() => ({ statusCode: 200, body: [] }));
      await client.listContainers({
        all: true,
        filters: { label: ['com.docker.compose.project=foo', 'com.docker.compose.service=worker'] },
      });
      const captured = fake.requests[0]!;
      expect(captured.method).toBe('GET');
      expect(captured.url).toContain('/containers/json');
      expect(captured.url).toContain('all=true');
      const filtersParam = new URL('http://x' + captured.url).searchParams.get('filters');
      expect(filtersParam).not.toBeNull();
      expect(JSON.parse(filtersParam!)).toEqual({
        label: ['com.docker.compose.project=foo', 'com.docker.compose.service=worker'],
      });
    });

    it('returns parsed container summaries', async () => {
      fake.setHandler(() => ({
        statusCode: 200,
        body: [{ Id: 'abc', Names: ['/foo'], Labels: {}, State: 'running' }],
      }));
      const result = await client.listContainers();
      expect(result).toHaveLength(1);
      expect(result[0]!.Id).toBe('abc');
    });
  });

  describe('inspectContainer', () => {
    it('GETs /containers/<id>/json and returns parsed inspect', async () => {
      fake.setHandler(() => ({
        statusCode: 200,
        body: { Id: 'abc', Name: '/foo', Image: 'img', Config: {}, HostConfig: {}, NetworkSettings: { Networks: {} } },
      }));
      const result = await client.inspectContainer('abc');
      expect(fake.requests[0]!.url).toBe('/containers/abc/json');
      expect(result.Id).toBe('abc');
    });
  });

  describe('createContainer', () => {
    it('POSTs JSON body with name query parameter', async () => {
      fake.setHandler(() => ({ statusCode: 201, body: { Id: 'new-id', Warnings: [] } }));
      const result = await client.createContainer('proj-worker-3', {
        Image: 'img:latest',
        HostConfig: {},
        NetworkingConfig: { EndpointsConfig: { mynet: {} } },
      });
      const captured = fake.requests[0]!;
      expect(captured.method).toBe('POST');
      expect(captured.url).toBe('/containers/create?name=proj-worker-3');
      expect(captured.headers['content-type']).toBe('application/json');
      const parsed = JSON.parse(captured.body) as { Image: string };
      expect(parsed.Image).toBe('img:latest');
      expect(result.Id).toBe('new-id');
    });
  });

  describe('startContainer / stopContainer / removeContainer', () => {
    it('POSTs to /start', async () => {
      fake.setHandler(() => ({ statusCode: 204 }));
      await client.startContainer('abc');
      expect(fake.requests[0]!.url).toBe('/containers/abc/start');
      expect(fake.requests[0]!.method).toBe('POST');
    });

    it('treats 304 (already stopped) as success on stop', async () => {
      fake.setHandler(() => ({ statusCode: 304 }));
      await expect(client.stopContainer('abc')).resolves.toBeUndefined();
    });

    it('appends force=true on removeContainer', async () => {
      fake.setHandler(() => ({ statusCode: 204 }));
      await client.removeContainer('abc', { force: true });
      expect(fake.requests[0]!.url).toBe('/containers/abc?force=true');
      expect(fake.requests[0]!.method).toBe('DELETE');
    });

    it('omits force query param when not requested', async () => {
      fake.setHandler(() => ({ statusCode: 204 }));
      await client.removeContainer('abc');
      expect(fake.requests[0]!.url).toBe('/containers/abc');
    });
  });

  describe('connectNetwork', () => {
    it('POSTs network connect body to /networks/<id>/connect', async () => {
      fake.setHandler(() => ({ statusCode: 200 }));
      await client.connectNetwork('net-id', { Container: 'cont-id' });
      const captured = fake.requests[0]!;
      expect(captured.method).toBe('POST');
      expect(captured.url).toBe('/networks/net-id/connect');
      expect(JSON.parse(captured.body)).toEqual({ Container: 'cont-id' });
    });
  });

  describe('error mapping', () => {
    it('maps ECONNREFUSED / unreachable socket to DockerDaemonUnavailableError', async () => {
      // Close the fake server so the next request gets ECONNREFUSED.
      await fake.close();
      // Re-open a no-server path
      const tempDir = mkdtempSync(join(tmpdir(), 'docker-engine-missing-'));
      const missingSocket = join(tempDir, 'docker.sock');
      const offlineClient = new DockerEngineClient({ dockerHost: `unix://${missingSocket}` });

      await expect(offlineClient.listContainers()).rejects.toBeInstanceOf(
        DockerDaemonUnavailableError,
      );
      rmSync(tempDir, { recursive: true, force: true });

      // Recreate fake so afterEach has something to close.
      fake = await startFakeEngine();
      client = new DockerEngineClient({ dockerHost: `unix://${fake.socketPath}` });
    });

    it('maps non-2xx to DockerEngineError with engine message extracted', async () => {
      fake.setHandler(() => ({ statusCode: 500, body: { message: 'something broke' } }));
      try {
        await client.listContainers();
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(DockerEngineError);
        const dee = err as DockerEngineError;
        expect(dee.statusCode).toBe(500);
        expect(dee.engineMessage).toBe('something broke');
        expect(dee.endpoint).toContain('/containers/json');
      }
    });

    it('falls back to raw body when engine response is not JSON', async () => {
      fake.setHandler(() => ({ statusCode: 500, body: 'not json' }));
      try {
        await client.listContainers();
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(DockerEngineError);
        expect((err as DockerEngineError).engineMessage).toBe('not json');
      }
    });
  });

  describe('DOCKER_HOST scheme validation', () => {
    it('rejects non-unix:// scheme', () => {
      expect(() => new DockerEngineClient({ dockerHost: 'tcp://127.0.0.1:2375' })).toThrow(
        /unix:\/\//,
      );
    });
  });
});
