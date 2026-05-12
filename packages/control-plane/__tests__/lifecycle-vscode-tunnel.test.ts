import http from 'node:http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handlePostLifecycle } from '../src/routes/lifecycle.js';
import { ControlPlaneError } from '../src/errors.js';
import type { ActorContext } from '../src/context.js';
import {
  setVsCodeTunnelManager,
  type VsCodeTunnelManager,
  type VsCodeTunnelStartResult,
} from '../src/services/vscode-tunnel-manager.js';
import { setCodeServerManager, type CodeServerManager } from '../src/services/code-server-manager.js';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

function createMockReq(method: string, url: string) {
  return { method, url, headers: {} } as unknown as http.IncomingMessage;
}

function createMockRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) { res.headers[name] = value; },
    writeHead(status: number) { res.statusCode = status; },
    end(data?: string) { res.body = data ?? ''; },
  };
  return res as unknown as http.ServerResponse;
}

function createMockTunnelManager(overrides: Partial<VsCodeTunnelManager> = {}): VsCodeTunnelManager {
  return {
    start: vi.fn<() => Promise<VsCodeTunnelStartResult>>().mockResolvedValue({
      status: 'starting',
      tunnelName: 'test-cluster',
    }),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue('stopped'),
    shutdown: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockCodeServerManager(): CodeServerManager {
  return {
    start: vi.fn().mockResolvedValue({ status: 'starting', socket_path: '/run/code-server.sock' }),
    stop: vi.fn().mockResolvedValue(undefined),
    touch: vi.fn(),
    getStatus: vi.fn().mockReturnValue('stopped'),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

const actor: ActorContext = { userId: 'test-user', sessionId: 'test-session' };

describe('lifecycle vscode-tunnel actions', () => {
  let tunnelManager: VsCodeTunnelManager;

  beforeEach(() => {
    tunnelManager = createMockTunnelManager();
    setVsCodeTunnelManager(tunnelManager);
    setCodeServerManager(createMockCodeServerManager());
  });

  afterEach(() => {
    setVsCodeTunnelManager(null);
    setCodeServerManager(null);
  });

  describe('vscode-tunnel-start', () => {
    it('calls tunnel manager start() and returns result', async () => {
      const req = createMockReq('POST', '/lifecycle/vscode-tunnel-start');
      const res = createMockRes();

      await handlePostLifecycle(req, res, actor, { action: 'vscode-tunnel-start' });

      expect(tunnelManager.start).toHaveBeenCalledOnce();
      expect((res as any).statusCode).toBe(200);
      const body = JSON.parse((res as any).body);
      expect(body).toEqual({ status: 'starting', tunnelName: 'test-cluster' });
    });

    it('throws ControlPlaneError with SERVICE_UNAVAILABLE when start() throws', async () => {
      const errorMessage = 'CLI binary not found';
      const failingManager = createMockTunnelManager({
        start: vi.fn().mockRejectedValue(new Error(errorMessage)),
      });
      setVsCodeTunnelManager(failingManager);

      const req = createMockReq('POST', '/lifecycle/vscode-tunnel-start');
      const res = createMockRes();

      await expect(
        handlePostLifecycle(req, res, actor, { action: 'vscode-tunnel-start' }),
      ).rejects.toThrow(ControlPlaneError);

      try {
        await handlePostLifecycle(req, res, actor, { action: 'vscode-tunnel-start' });
      } catch (err) {
        expect(err).toBeInstanceOf(ControlPlaneError);
        expect((err as ControlPlaneError).code).toBe('SERVICE_UNAVAILABLE');
        expect((err as ControlPlaneError).message).toBe(errorMessage);
      }
    });
  });

  describe('vscode-tunnel-stop', () => {
    it('calls tunnel manager stop() and returns accepted response', async () => {
      const req = createMockReq('POST', '/lifecycle/vscode-tunnel-stop');
      const res = createMockRes();

      await handlePostLifecycle(req, res, actor, { action: 'vscode-tunnel-stop' });

      expect(tunnelManager.stop).toHaveBeenCalledOnce();
      expect((res as any).statusCode).toBe(200);
      const body = JSON.parse((res as any).body);
      expect(body).toEqual({ accepted: true, action: 'vscode-tunnel-stop' });
    });
  });

  describe('bootstrap-complete', () => {
    it('calls tunnel manager start() as auto-start', async () => {
      const { writeFile } = await import('node:fs/promises');
      const req = createMockReq('POST', '/lifecycle/bootstrap-complete');
      const res = createMockRes();

      await handlePostLifecycle(req, res, actor, { action: 'bootstrap-complete' });

      expect(writeFile).toHaveBeenCalledWith(
        '/tmp/generacy-bootstrap-complete',
        '',
        { flag: 'w' },
      );
      expect(tunnelManager.start).toHaveBeenCalledOnce();
      expect((res as any).statusCode).toBe(200);
      const body = JSON.parse((res as any).body);
      expect(body).toEqual({
        accepted: true,
        action: 'bootstrap-complete',
        sentinel: '/tmp/generacy-bootstrap-complete',
      });
    });

    it('succeeds even when tunnel manager start() throws (best-effort)', async () => {
      const failingManager = createMockTunnelManager({
        start: vi.fn().mockRejectedValue(new Error('tunnel binary missing')),
      });
      setVsCodeTunnelManager(failingManager);

      const req = createMockReq('POST', '/lifecycle/bootstrap-complete');
      const res = createMockRes();

      await handlePostLifecycle(req, res, actor, { action: 'bootstrap-complete' });

      expect(failingManager.start).toHaveBeenCalledOnce();
      expect((res as any).statusCode).toBe(200);
      const body = JSON.parse((res as any).body);
      expect(body).toEqual({
        accepted: true,
        action: 'bootstrap-complete',
        sentinel: '/tmp/generacy-bootstrap-complete',
      });
    });
  });
});
