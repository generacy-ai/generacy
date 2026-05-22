import { describe, it, expect, vi, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handlePostLifecycle } from '../../src/routes/lifecycle.js';
import { ControlPlaneError } from '../../src/errors.js';

vi.mock('../../src/services/peer-repo-cloner.js', () => ({
  clonePeerRepos: vi.fn(async () => []),
}));
vi.mock('../../src/services/wizard-env-writer.js', () => ({
  writeWizardEnvFile: vi.fn(async () => ({ written: [], failed: [] })),
}));
vi.mock('../../src/relay-events.js', () => ({
  getRelayPushEvent: vi.fn(() => undefined),
}));

const mockScaleWorkers = vi.fn();
vi.mock('../../src/services/worker-scaler.js', () => ({
  scaleWorkers: (...args: unknown[]) => mockScaleWorkers(...args),
}));

const mockReadBody = vi.fn();
vi.mock('../../src/util/read-body.js', () => ({
  readBody: (...args: unknown[]) => mockReadBody(...args),
}));

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
    get _headers() { return headers; },
    get _statusCode() { return statusCode; },
    get _body() { return body; },
  } as unknown as ServerResponse & {
    _headers: Record<string, string>;
    _statusCode: number | undefined;
    _body: string;
  };

  return res;
}

describe('lifecycle: worker-scale', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts valid count and returns scale result', async () => {
    mockReadBody.mockResolvedValueOnce(JSON.stringify({ count: 4 }));
    mockScaleWorkers.mockResolvedValueOnce({ previousCount: 2, requestedCount: 4 });

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'worker-scale' });

    expect(mockScaleWorkers).toHaveBeenCalledWith({ count: 4 });
    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res._body);
    expect(body).toEqual({
      accepted: true,
      action: 'worker-scale',
      previousCount: 2,
      requestedCount: 4,
    });
  });

  it('rejects count < 1', async () => {
    mockReadBody.mockResolvedValueOnce(JSON.stringify({ count: 0 }));

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await expect(
      handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'worker-scale' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects non-integer count', async () => {
    mockReadBody.mockResolvedValueOnce(JSON.stringify({ count: 2.5 }));

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await expect(
      handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'worker-scale' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects missing count field', async () => {
    mockReadBody.mockResolvedValueOnce(JSON.stringify({}));

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await expect(
      handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'worker-scale' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects invalid JSON body', async () => {
    mockReadBody.mockResolvedValueOnce('not json');

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await expect(
      handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'worker-scale' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('returns SERVICE_UNAVAILABLE when docker CLI is missing', async () => {
    mockReadBody.mockResolvedValueOnce(JSON.stringify({ count: 2 }));
    mockScaleWorkers.mockRejectedValueOnce(new Error('DOCKER_CLI_UNAVAILABLE'));

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await expect(
      handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'worker-scale' }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('returns INTERNAL_ERROR for other scale failures', async () => {
    mockReadBody.mockResolvedValueOnce(JSON.stringify({ count: 2 }));
    mockScaleWorkers.mockRejectedValueOnce(new Error('compose crashed'));

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await expect(
      handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'worker-scale' }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
