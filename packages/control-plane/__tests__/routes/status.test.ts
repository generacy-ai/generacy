import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handlePostStatus } from '../../src/routes/status.js';
import { initClusterState, getClusterState, updateClusterStatus } from '../../src/state.js';
import { ControlPlaneError } from '../../src/errors.js';

function createMockRequest(body: unknown): IncomingMessage {
  const data = JSON.stringify(body);
  const stream = new Readable({
    read() {
      this.push(data);
      this.push(null);
    },
  });
  return stream as unknown as IncomingMessage;
}

function createMockRequestRaw(raw: string): IncomingMessage {
  const stream = new Readable({
    read() {
      this.push(raw);
      this.push(null);
    },
  });
  return stream as unknown as IncomingMessage;
}

function createMockResponse() {
  const headers: Record<string, string> = {};
  let statusCode: number | undefined;
  let body = '';

  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    writeHead: vi.fn((code: number, h?: Record<string, string>) => {
      statusCode = code;
      if (h) Object.assign(headers, h);
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

describe('handlePostStatus', () => {
  beforeEach(() => {
    initClusterState({ deploymentMode: 'local', variant: 'cluster-base' });
  });

  it('accepts valid transition bootstrapping → ready', async () => {
    const req = createMockRequest({ status: 'ready' });
    const res = createMockResponse();

    await handlePostStatus(req, res, {}, {});

    expect(res._statusCode).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ ok: true });
    expect(getClusterState().status).toBe('ready');
  });

  it('accepts valid transition ready → degraded', async () => {
    updateClusterStatus('ready');

    const req = createMockRequest({ status: 'degraded', statusReason: 'Relay lost' });
    const res = createMockResponse();

    await handlePostStatus(req, res, {}, {});

    expect(res._statusCode).toBe(200);
    const state = getClusterState();
    expect(state.status).toBe('degraded');
    expect(state.statusReason).toBe('Relay lost');
  });

  it('accepts degraded → ready recovery', async () => {
    updateClusterStatus('ready');
    updateClusterStatus('degraded', 'Relay lost');

    const req = createMockRequest({ status: 'ready' });
    const res = createMockResponse();

    await handlePostStatus(req, res, {}, {});

    expect(res._statusCode).toBe(200);
    expect(getClusterState().status).toBe('ready');
  });

  it('rejects invalid status value with 400', async () => {
    const req = createMockRequest({ status: 'invalid-status' });
    const res = createMockResponse();

    await expect(handlePostStatus(req, res, {}, {})).rejects.toThrow(ControlPlaneError);
    try {
      await handlePostStatus(createMockRequest({ status: 'invalid-status' }), createMockResponse(), {}, {});
    } catch (err) {
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect((err as ControlPlaneError).code).toBe('INVALID_REQUEST');
    }
  });

  it('rejects transition from terminal error state', async () => {
    updateClusterStatus('error', 'Fatal');

    const req = createMockRequest({ status: 'ready' });
    const res = createMockResponse();

    await expect(handlePostStatus(req, res, {}, {})).rejects.toThrow(ControlPlaneError);
    try {
      await handlePostStatus(
        createMockRequest({ status: 'ready' }),
        createMockResponse(),
        {},
        {},
      );
    } catch (err) {
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect((err as ControlPlaneError).code).toBe('INVALID_REQUEST');
    }
  });

  it('statusReason reflected in subsequent GET /state', async () => {
    const req = createMockRequest({ status: 'error', statusReason: 'Config corrupt' });
    const res = createMockResponse();

    await handlePostStatus(req, res, {}, {});

    const state = getClusterState();
    expect(state.status).toBe('error');
    expect(state.statusReason).toBe('Config corrupt');
  });

  it('rejects invalid JSON body', async () => {
    const req = createMockRequestRaw('not json');
    const res = createMockResponse();

    await expect(handlePostStatus(req, res, {}, {})).rejects.toThrow(ControlPlaneError);
  });

  it('clears statusReason when new status omits it', async () => {
    updateClusterStatus('ready');
    updateClusterStatus('degraded', 'Some reason');

    const req = createMockRequest({ status: 'ready' });
    const res = createMockResponse();

    await handlePostStatus(req, res, {}, {});

    const state = getClusterState();
    expect(state.status).toBe('ready');
    expect(state.statusReason).toBeUndefined();
  });
});
