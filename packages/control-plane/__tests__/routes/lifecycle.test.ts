import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handlePostLifecycle } from '../../src/routes/lifecycle.js';
import { ControlPlaneError } from '../../src/errors.js';

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

describe('handlePostLifecycle', () => {
  it('returns 200 with accepted: true for clone-peer-repos', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handlePostLifecycle(req, res, {}, { action: 'clone-peer-repos' });

    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res._body);
    expect(body).toEqual({ accepted: true, action: 'clone-peer-repos' });
  });

  it('returns 200 with accepted: true for code-server-start', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handlePostLifecycle(req, res, {}, { action: 'code-server-start' });

    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res._body);
    expect(body).toEqual({ accepted: true, action: 'code-server-start' });
  });

  it('returns 200 with accepted: true for code-server-stop', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handlePostLifecycle(req, res, {}, { action: 'code-server-stop' });

    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res._body);
    expect(body).toEqual({ accepted: true, action: 'code-server-stop' });
  });

  it('throws ControlPlaneError with code UNKNOWN_ACTION for invalid action', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await expect(
      handlePostLifecycle(req, res, {}, { action: 'invalid-action' }),
    ).rejects.toThrow(ControlPlaneError);

    try {
      await handlePostLifecycle(req, res, {}, { action: 'invalid-action' });
    } catch (err) {
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect((err as ControlPlaneError).code).toBe('UNKNOWN_ACTION');
    }
  });

  it('sets Content-Type to application/json', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handlePostLifecycle(req, res, {}, { action: 'clone-peer-repos' });

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(res._headers['Content-Type']).toBe('application/json');
  });
});
