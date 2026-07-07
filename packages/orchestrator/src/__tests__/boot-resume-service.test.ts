import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import type { FastifyBaseLogger } from 'fastify';

vi.mock('../services/control-plane-probe.js', () => ({
  probeControlPlaneSocket: vi.fn(async () => true),
}));

import { BootResumeService } from '../services/boot-resume-service.js';
import { probeControlPlaneSocket } from '../services/control-plane-probe.js';

const mockProbe = vi.mocked(probeControlPlaneSocket);

function createMockLogger(): FastifyBaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => createMockLogger()),
    level: 'info',
    silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

type CapturedRequest = {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

type ResponseConfig = {
  status: number;
  body?: string;
};

describe('BootResumeService', () => {
  let tempDir: string;
  let logger: FastifyBaseLogger;
  let socketPath: string;
  let mockServer: http.Server;
  let requestCounts: Map<string, number>;
  let requests: CapturedRequest[];
  let responses: Map<string, ResponseConfig>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'boot-resume-test-'));
    logger = createMockLogger();
    socketPath = join(tempDir, 'control-plane.sock');
    requestCounts = new Map();
    requests = [];
    responses = new Map();

    mockProbe.mockResolvedValue(true);

    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const path = req.url ?? '';
        requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
        requests.push({
          path,
          method: req.method ?? '',
          headers: req.headers as Record<string, string>,
          body,
        });
        const config = responses.get(path) ?? { status: 200, body: JSON.stringify({ ok: true }) };
        res.writeHead(config.status, { 'Content-Type': 'application/json' });
        res.end(config.body ?? '');
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(socketPath, resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      mockServer.close(() => resolve());
    });
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('triggerBootResume — happy path', () => {
    it('fires both POSTs and emits no cluster.bootstrap events on 2xx', async () => {
      responses.set('/lifecycle/vscode-tunnel-start', { status: 200, body: '{}' });
      responses.set('/lifecycle/code-server-start', { status: 200, body: '{}' });
      const sendRelayEvent = vi.fn();

      const service = new BootResumeService({
        logger,
        controlPlaneSocket: socketPath,
        controlPlaneWaitTimeout: 2,
        sendRelayEvent,
      });

      await service.triggerBootResume();

      expect(requestCounts.get('/lifecycle/vscode-tunnel-start')).toBe(1);
      expect(requestCounts.get('/lifecycle/code-server-start')).toBe(1);

      const tunnelReq = requests.find((r) => r.path === '/lifecycle/vscode-tunnel-start');
      const codeServerReq = requests.find((r) => r.path === '/lifecycle/code-server-start');
      expect(tunnelReq?.method).toBe('POST');
      expect(codeServerReq?.method).toBe('POST');
      expect(JSON.parse(tunnelReq!.body)).toEqual({ action: 'vscode-tunnel-start' });
      expect(JSON.parse(codeServerReq!.body)).toEqual({ action: 'code-server-start' });
      expect(tunnelReq?.headers['x-generacy-actor-session-id']).toBe('boot-resume');
      expect(codeServerReq?.headers['x-generacy-actor-session-id']).toBe('boot-resume');

      const bootstrapEvents = sendRelayEvent.mock.calls.filter(
        (c) => c[0] === 'cluster.bootstrap',
      );
      expect(bootstrapEvents).toHaveLength(0);
    });
  });

  describe('triggerBootResume — partial failure', () => {
    it('emits vscode-tunnel event when tunnel POST fails, code-server POST still fires', async () => {
      responses.set('/lifecycle/vscode-tunnel-start', { status: 500, body: '{"error":"boom"}' });
      responses.set('/lifecycle/code-server-start', { status: 200, body: '{}' });
      const sendRelayEvent = vi.fn();

      const service = new BootResumeService({
        logger,
        controlPlaneSocket: socketPath,
        controlPlaneWaitTimeout: 2,
        sendRelayEvent,
      });

      await service.triggerBootResume();

      expect(requestCounts.get('/lifecycle/code-server-start')).toBe(1);

      const bootstrapEvents = sendRelayEvent.mock.calls.filter(
        (c) => c[0] === 'cluster.bootstrap',
      );
      expect(bootstrapEvents).toHaveLength(1);
      expect(bootstrapEvents[0][1]).toMatchObject({
        status: 'failed',
        reason: 'resume-failed',
        service: 'vscode-tunnel',
      });
    });

    it('emits code-server event when code-server POST fails, tunnel POST still fires', async () => {
      responses.set('/lifecycle/vscode-tunnel-start', { status: 200, body: '{}' });
      responses.set('/lifecycle/code-server-start', { status: 500, body: '{"error":"boom"}' });
      const sendRelayEvent = vi.fn();

      const service = new BootResumeService({
        logger,
        controlPlaneSocket: socketPath,
        controlPlaneWaitTimeout: 2,
        sendRelayEvent,
      });

      await service.triggerBootResume();

      expect(requestCounts.get('/lifecycle/vscode-tunnel-start')).toBe(1);

      const bootstrapEvents = sendRelayEvent.mock.calls.filter(
        (c) => c[0] === 'cluster.bootstrap',
      );
      expect(bootstrapEvents).toHaveLength(1);
      expect(bootstrapEvents[0][1]).toMatchObject({
        status: 'failed',
        reason: 'resume-failed',
        service: 'code-server',
      });
    });
  });

  describe('triggerBootResume — both fail', () => {
    it('fires both POSTs and emits two independent cluster.bootstrap events', async () => {
      responses.set('/lifecycle/vscode-tunnel-start', { status: 500, body: '{"error":"tunnel"}' });
      responses.set('/lifecycle/code-server-start', { status: 500, body: '{"error":"cs"}' });
      const sendRelayEvent = vi.fn();

      const service = new BootResumeService({
        logger,
        controlPlaneSocket: socketPath,
        controlPlaneWaitTimeout: 2,
        sendRelayEvent,
      });

      await service.triggerBootResume();

      expect(requestCounts.get('/lifecycle/vscode-tunnel-start')).toBe(1);
      expect(requestCounts.get('/lifecycle/code-server-start')).toBe(1);

      const bootstrapEvents = sendRelayEvent.mock.calls.filter(
        (c) => c[0] === 'cluster.bootstrap',
      );
      expect(bootstrapEvents).toHaveLength(2);
      const services = bootstrapEvents.map((e) => (e[1] as { service: string }).service).sort();
      expect(services).toEqual(['code-server', 'vscode-tunnel']);
      for (const [, payload] of bootstrapEvents) {
        expect(payload).toMatchObject({
          status: 'failed',
          reason: 'resume-failed',
        });
      }
    });
  });

  describe('triggerBootResume — socket not ready', () => {
    it('emits both failure events in order, fires no POSTs when socket never becomes ready', async () => {
      mockProbe.mockResolvedValue(false);
      const sendRelayEvent = vi.fn();

      const service = new BootResumeService({
        logger,
        controlPlaneSocket: join(tempDir, 'nonexistent.sock'),
        controlPlaneWaitTimeout: 1,
        sendRelayEvent,
      });

      await service.triggerBootResume();

      expect(requestCounts.size).toBe(0);

      const bootstrapEvents = sendRelayEvent.mock.calls.filter(
        (c) => c[0] === 'cluster.bootstrap',
      );
      expect(bootstrapEvents).toHaveLength(2);
      expect((bootstrapEvents[0][1] as { service: string }).service).toBe('vscode-tunnel');
      expect((bootstrapEvents[1][1] as { service: string }).service).toBe('code-server');
      for (const [, payload] of bootstrapEvents) {
        expect(payload).toMatchObject({
          status: 'failed',
          reason: 'resume-failed',
          error: 'Control-plane socket did not become ready',
        });
      }
    });
  });

  describe('triggerBootResume — single-shot', () => {
    it('does not retry the tunnel POST on failure (exactly one attempt)', async () => {
      responses.set('/lifecycle/vscode-tunnel-start', { status: 500, body: '{"error":"boom"}' });
      responses.set('/lifecycle/code-server-start', { status: 200, body: '{}' });
      const sendRelayEvent = vi.fn();

      const service = new BootResumeService({
        logger,
        controlPlaneSocket: socketPath,
        controlPlaneWaitTimeout: 2,
        sendRelayEvent,
      });

      await service.triggerBootResume();

      expect(requestCounts.get('/lifecycle/vscode-tunnel-start')).toBe(1);
    });
  });

  describe('triggerBootResume — nullable sendRelayEvent', () => {
    it('resolves without throwing when sendRelayEvent is undefined and both POSTs fail', async () => {
      responses.set('/lifecycle/vscode-tunnel-start', { status: 500, body: '{"error":"boom"}' });
      responses.set('/lifecycle/code-server-start', { status: 500, body: '{"error":"boom"}' });

      const service = new BootResumeService({
        logger,
        controlPlaneSocket: socketPath,
        controlPlaneWaitTimeout: 2,
      });

      await expect(service.triggerBootResume()).resolves.toBeUndefined();
    });
  });
});
