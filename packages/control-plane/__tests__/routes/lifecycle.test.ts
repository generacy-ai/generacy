import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handlePostLifecycle } from '../../src/routes/lifecycle.js';
import { ControlPlaneError } from '../../src/errors.js';
import type { ActorContext } from '../../src/context.js';
import {
  setCodeServerManager,
  type CodeServerManager,
} from '../../src/services/code-server-manager.js';

function createMockResponse() {
  const headers: Record<string, string> = {};
  let statusCode: number | undefined;
  let body = '';

  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    writeHead: vi.fn((code: number) => {
      statusCode = code;
    }),
    end: vi.fn((data?: string) => {
      if (data) body = data;
    }),
    get _headers() {
      return headers;
    },
    get _statusCode() {
      return statusCode;
    },
    get _body() {
      return body;
    },
  } as unknown as ServerResponse & {
    _headers: Record<string, string>;
    _statusCode: number | undefined;
    _body: string;
  };

  return res;
}

function createFakeManager(overrides: Partial<CodeServerManager> = {}): CodeServerManager {
  return {
    start: vi.fn(async () => ({ status: 'starting' as const, socket_path: '/tmp/cs.sock' })),
    stop: vi.fn(async () => {}),
    touch: vi.fn(),
    getStatus: vi.fn(() => 'stopped' as const),
    shutdown: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('handlePostLifecycle', () => {
  afterEach(() => {
    setCodeServerManager(null);
  });

  it('returns 200 with accepted: true for clone-peer-repos', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'clone-peer-repos' });

    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res._body);
    expect(body).toEqual({ accepted: true, action: 'clone-peer-repos' });
  });

  it('starts code-server and returns its status + socket_path', async () => {
    const manager = createFakeManager({
      start: vi.fn(async () => ({ status: 'starting', socket_path: '/run/code-server.sock' })),
    });
    setCodeServerManager(manager);

    const req = {} as IncomingMessage;
    const res = createMockResponse();
    await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'code-server-start' });

    expect(manager.start).toHaveBeenCalledOnce();
    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res._body);
    expect(body).toEqual({ status: 'starting', socket_path: '/run/code-server.sock' });
  });

  it('surfaces SERVICE_UNAVAILABLE if code-server fails to start', async () => {
    const manager = createFakeManager({
      start: vi.fn(async () => {
        throw new Error('binary not found');
      }),
    });
    setCodeServerManager(manager);

    await expect(
      handlePostLifecycle({} as IncomingMessage, createMockResponse(), { userId: 'u-test' }, {
        action: 'code-server-start',
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'binary not found' });
  });

  it('stops code-server and returns accepted: true', async () => {
    const manager = createFakeManager();
    setCodeServerManager(manager);

    const req = {} as IncomingMessage;
    const res = createMockResponse();
    await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'code-server-stop' });

    expect(manager.stop).toHaveBeenCalledOnce();
    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res._body);
    expect(body).toEqual({ accepted: true, action: 'code-server-stop' });
  });

  it('throws ControlPlaneError with code UNKNOWN_ACTION for invalid action', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await expect(
      handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'invalid-action' }),
    ).rejects.toThrow(ControlPlaneError);

    try {
      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'invalid-action' });
    } catch (err) {
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect((err as ControlPlaneError).code).toBe('UNKNOWN_ACTION');
    }
  });

  it('sets Content-Type to application/json', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'clone-peer-repos' });

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(res._headers['Content-Type']).toBe('application/json');
  });

  it('throws UNAUTHORIZED when actor userId is missing', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();
    const noActor: ActorContext = {};

    await expect(
      handlePostLifecycle(req, res, noActor, { action: 'clone-peer-repos' }),
    ).rejects.toThrow(ControlPlaneError);

    try {
      await handlePostLifecycle(req, res, noActor, { action: 'clone-peer-repos' });
    } catch (err) {
      expect((err as ControlPlaneError).code).toBe('UNAUTHORIZED');
      expect((err as ControlPlaneError).message).toBe('Missing actor identity');
    }
  });
});
