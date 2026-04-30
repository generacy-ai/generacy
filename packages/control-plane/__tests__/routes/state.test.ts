import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGetState } from '../../src/routes/state.js';
import { initClusterState, updateClusterStatus } from '../../src/state.js';

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
    // Expose captured values for assertions
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

describe('handleGetState', () => {
  beforeEach(() => {
    initClusterState({ deploymentMode: 'local', variant: 'cluster-base' });
  });

  it('returns 200 status code', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetState(req, res, {}, {});

    expect(res.writeHead).toHaveBeenCalledWith(200);
    expect(res._statusCode).toBe(200);
  });

  it('default status is bootstrapping', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetState(req, res, {}, {});

    const body = JSON.parse(res._body);
    expect(body.status).toBe('bootstrapping');
  });

  it('returns default deploymentMode "local"', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetState(req, res, {}, {});

    const body = JSON.parse(res._body);
    expect(body.deploymentMode).toBe('local');
  });

  it('returns default variant "cluster-base"', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetState(req, res, {}, {});

    const body = JSON.parse(res._body);
    expect(body.variant).toBe('cluster-base');
  });

  it('reflects custom DEPLOYMENT_MODE=cloud', async () => {
    initClusterState({ deploymentMode: 'cloud', variant: 'cluster-base' });

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetState(req, res, {}, {});

    const body = JSON.parse(res._body);
    expect(body.deploymentMode).toBe('cloud');
  });

  it('reflects custom CLUSTER_VARIANT=cluster-microservices', async () => {
    initClusterState({ deploymentMode: 'local', variant: 'cluster-microservices' });

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetState(req, res, {}, {});

    const body = JSON.parse(res._body);
    expect(body.variant).toBe('cluster-microservices');
  });

  it('includes statusReason when set', async () => {
    updateClusterStatus('ready');
    updateClusterStatus('degraded', 'Relay disconnected');

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetState(req, res, {}, {});

    const body = JSON.parse(res._body);
    expect(body.status).toBe('degraded');
    expect(body.statusReason).toBe('Relay disconnected');
  });

  it('omits statusReason when absent', async () => {
    updateClusterStatus('ready');

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetState(req, res, {}, {});

    const body = JSON.parse(res._body);
    expect(body.status).toBe('ready');
    expect(body.statusReason).toBeUndefined();
  });

  it('response body has a valid ISO datetime lastSeen', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    const before = new Date().toISOString();
    await handleGetState(req, res, {}, {});
    const after = new Date().toISOString();

    const body = JSON.parse(res._body);
    expect(body.lastSeen).toBeDefined();
    const parsed = new Date(body.lastSeen);
    expect(parsed.toISOString()).toBe(body.lastSeen);
    expect(body.lastSeen >= before).toBe(true);
    expect(body.lastSeen <= after).toBe(true);
  });

  it('sets Content-Type to application/json', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetState(req, res, {}, {});

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(res._headers['Content-Type']).toBe('application/json');
  });
});
