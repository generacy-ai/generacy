import http from 'node:http';
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach } from 'vitest';
import { dispatch } from '../src/router.js';
import { ControlPlaneError } from '../src/errors.js';
import type { ActorContext } from '../src/context.js';
import { initClusterState } from '../src/state.js';

function createMockReq(method: string, url: string, headers?: Record<string, string>) {
  return { method, url, headers: headers ?? {} } as unknown as http.IncomingMessage;
}

/**
 * Creates a mock request backed by an EventEmitter so that handlers calling
 * `readBody(req)` (which listens for 'data' and 'end' events) can resolve.
 * After creation the caller should call `emitter.emit('end')` to unblock body reads.
 */
function createMockReqWithBody(method: string, url: string, body: string = '') {
  const emitter = new EventEmitter();
  const req = Object.assign(emitter, {
    method,
    url,
    headers: {} as Record<string, string>,
  }) as unknown as http.IncomingMessage;

  // Schedule the body data + end events on the next microtick so the handler
  // has time to attach its listeners.
  queueMicrotask(() => {
    if (body.length > 0) {
      emitter.emit('data', Buffer.from(body));
    }
    emitter.emit('end');
  });

  return req;
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

const actor: ActorContext = { userId: 'test-user', sessionId: 'test-session' };

describe('dispatch', () => {
  beforeEach(() => {
    initClusterState({ deploymentMode: 'local', variant: 'cluster-base' });
  });

  it('GET /state dispatches to state handler and returns 200', async () => {
    const req = createMockReq('GET', '/state');
    const res = createMockRes();

    await dispatch(req, res, actor);

    expect((res as any).statusCode).toBe(200);
    const body = JSON.parse((res as any).body);
    expect(body).toHaveProperty('status', 'bootstrapping');
    expect(body).toHaveProperty('deploymentMode', 'local');
    expect(body).toHaveProperty('variant', 'cluster-base');
  });

  it('GET /credentials/abc dispatches to credential GET handler and returns 200', async () => {
    const req = createMockReq('GET', '/credentials/abc');
    const res = createMockRes();

    await dispatch(req, res, actor);

    expect((res as any).statusCode).toBe(200);
    const body = JSON.parse((res as any).body);
    expect(body).toHaveProperty('id', 'abc');
    expect(body).toHaveProperty('type', 'api-key');
    expect(body).toHaveProperty('backend', 'env');
  });

  it('PUT /credentials/abc dispatches to credential PUT handler and returns 200', async () => {
    const req = createMockReqWithBody('PUT', '/credentials/abc', '{"key":"val"}');
    const res = createMockRes();

    await dispatch(req, res, actor);

    expect((res as any).statusCode).toBe(200);
    const body = JSON.parse((res as any).body);
    expect(body).toEqual({ ok: true });
  });

  it('GET /roles/abc dispatches to role GET handler and returns 200', async () => {
    const req = createMockReq('GET', '/roles/abc');
    const res = createMockRes();

    await dispatch(req, res, actor);

    expect((res as any).statusCode).toBe(200);
    const body = JSON.parse((res as any).body);
    expect(body).toHaveProperty('id', 'abc');
    expect(body).toHaveProperty('description', 'Stub role');
    expect(body).toHaveProperty('credentials');
  });

  it('PUT /roles/abc dispatches to role PUT handler and returns 200', async () => {
    const req = createMockReqWithBody('PUT', '/roles/abc', '{"name":"test"}');
    const res = createMockRes();

    await dispatch(req, res, actor);

    expect((res as any).statusCode).toBe(200);
    const body = JSON.parse((res as any).body);
    expect(body).toEqual({ ok: true });
  });

  it('POST /lifecycle/clone-peer-repos dispatches to lifecycle handler and returns 200', async () => {
    const req = createMockReq('POST', '/lifecycle/clone-peer-repos');
    const res = createMockRes();

    await dispatch(req, res, actor);

    expect((res as any).statusCode).toBe(200);
    const body = JSON.parse((res as any).body);
    expect(body).toEqual({ accepted: true, action: 'clone-peer-repos' });
  });

  it('GET /unknown throws NOT_FOUND ControlPlaneError', async () => {
    const req = createMockReq('GET', '/unknown');
    const res = createMockRes();

    await expect(dispatch(req, res, actor)).rejects.toThrow(ControlPlaneError);

    try {
      await dispatch(req, res, actor);
    } catch (err) {
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect((err as ControlPlaneError).code).toBe('NOT_FOUND');
    }
  });

  it('POST /state throws INVALID_REQUEST ControlPlaneError (method not allowed)', async () => {
    const req = createMockReq('POST', '/state');
    const res = createMockRes();

    await expect(dispatch(req, res, actor)).rejects.toThrow(ControlPlaneError);

    try {
      await dispatch(req, res, actor);
    } catch (err) {
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect((err as ControlPlaneError).code).toBe('INVALID_REQUEST');
    }
  });
});
