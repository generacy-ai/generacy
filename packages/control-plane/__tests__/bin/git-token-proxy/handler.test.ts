import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import type http from 'node:http';
import { createHandler, MAX_BODY_BYTES } from '../../../src/git-token-proxy/index.js';

/** Minimal IncomingMessage-shaped fixture driven manually via events. */
function makeReq(opts: {
  method: string | undefined;
  url: string | undefined;
  headers?: http.IncomingHttpHeaders;
}): http.IncomingMessage {
  const emitter = new PassThrough() as unknown as http.IncomingMessage;
  (emitter as unknown as { method: string | undefined }).method = opts.method;
  (emitter as unknown as { url: string | undefined }).url = opts.url;
  (emitter as unknown as { headers: http.IncomingHttpHeaders }).headers = opts.headers ?? {};
  return emitter;
}

interface ResponseCapture {
  res: http.ServerResponse;
  statusCode: number | undefined;
  headers: http.OutgoingHttpHeaders | undefined;
  body: string;
  ended: boolean;
}

function makeRes(): ResponseCapture {
  const captured: ResponseCapture = {
    res: undefined as unknown as http.ServerResponse,
    statusCode: undefined,
    headers: undefined,
    body: '',
    ended: false,
  };
  const chunks: Buffer[] = [];
  const writeable = new PassThrough();
  writeable.on('data', (b: Buffer) => chunks.push(b));
  const res = writeable as unknown as http.ServerResponse & {
    headersSent: boolean;
    writableEnded: boolean;
  };
  res.headersSent = false;
  res.writableEnded = false;
  res.writeHead = ((status: number, headers?: http.OutgoingHttpHeaders) => {
    captured.statusCode = status;
    captured.headers = headers;
    res.headersSent = true;
    return res;
  }) as http.ServerResponse['writeHead'];
  const origEnd = writeable.end.bind(writeable);
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === 'string' || chunk instanceof Buffer) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    captured.ended = true;
    res.writableEnded = true;
    captured.body = Buffer.concat(chunks).toString('utf8');
    origEnd();
    return res;
  }) as http.ServerResponse['end'];
  captured.res = res;
  return captured;
}

interface FakeUpstreamRequest extends EventEmitter {
  writtenBody: Buffer[];
  ended: boolean;
  destroyed: boolean;
  options: http.RequestOptions;
  setTimeout(ms: number, cb: () => void): this;
  write(chunk: Buffer | string): boolean;
  end(): void;
  destroy(err?: Error): void;
  triggerError(err: Error): void;
  triggerResponse(res: Partial<http.IncomingMessage> & { statusCode: number; headers: http.IncomingHttpHeaders; body: string }): void;
}

function makeHttpRequestStub(): { stub: typeof http.request; calls: FakeUpstreamRequest[] } {
  const calls: FakeUpstreamRequest[] = [];
  const stub = ((options: http.RequestOptions) => {
    const emitter = new EventEmitter() as FakeUpstreamRequest;
    emitter.writtenBody = [];
    emitter.ended = false;
    emitter.destroyed = false;
    emitter.options = options;
    emitter.setTimeout = function (_ms: number, _cb: () => void) {
      return this;
    };
    emitter.write = function (chunk: Buffer | string) {
      this.writtenBody.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    };
    emitter.end = function () {
      this.ended = true;
    };
    emitter.destroy = function (err?: Error) {
      this.destroyed = true;
      if (err) this.emit('error', err);
    };
    emitter.triggerError = function (err: Error) {
      this.emit('error', err);
    };
    emitter.triggerResponse = function (resInit) {
      const stream = Readable.from([Buffer.from(resInit.body)]);
      Object.assign(stream, {
        statusCode: resInit.statusCode,
        headers: resInit.headers,
      });
      this.emit('response', stream);
    };
    calls.push(emitter);
    return emitter as unknown as ReturnType<typeof http.request>;
  }) as unknown as typeof http.request;
  return { stub, calls };
}

const UPSTREAM = '/tmp/test-control.sock';

describe('createHandler — route allow-list short-circuits upstream', () => {
  it('returns 404 on GET /git-token with zero upstream calls', async () => {
    const { stub, calls } = makeHttpRequestStub();
    const handler = createHandler({ upstreamSocketPath: UPSTREAM, httpRequest: stub });
    const req = makeReq({ method: 'GET', url: '/git-token' });
    const cap = makeRes();
    handler(req, cap.res);
    await new Promise((r) => setImmediate(r));
    expect(cap.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('returns 404 on POST /credentials/x with zero upstream calls', async () => {
    const { stub, calls } = makeHttpRequestStub();
    const handler = createHandler({ upstreamSocketPath: UPSTREAM, httpRequest: stub });
    const req = makeReq({ method: 'POST', url: '/credentials/x' });
    const cap = makeRes();
    handler(req, cap.res);
    await new Promise((r) => setImmediate(r));
    expect(cap.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('returns 404 on POST /git-token/ (trailing slash)', async () => {
    const { stub, calls } = makeHttpRequestStub();
    const handler = createHandler({ upstreamSocketPath: UPSTREAM, httpRequest: stub });
    const req = makeReq({ method: 'POST', url: '/git-token/' });
    const cap = makeRes();
    handler(req, cap.res);
    await new Promise((r) => setImmediate(r));
    expect(cap.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('createHandler — body cap', () => {
  it('returns 413 with PAYLOAD_TOO_LARGE when body > MAX_BODY_BYTES; upstream not contacted', async () => {
    const { stub, calls } = makeHttpRequestStub();
    const handler = createHandler({ upstreamSocketPath: UPSTREAM, httpRequest: stub });
    const req = makeReq({ method: 'POST', url: '/git-token' });
    const cap = makeRes();
    handler(req, cap.res);
    // Stream chunks until overflow
    (req as PassThrough).write(Buffer.alloc(MAX_BODY_BYTES + 1));
    (req as PassThrough).end();
    await new Promise((r) => setImmediate(r));
    expect(cap.statusCode).toBe(413);
    expect(JSON.parse(cap.body)).toEqual({
      error: expect.stringContaining('64 KiB'),
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('createHandler — header rewrite on success path', () => {
  it('forwards only content-type and content-length; strips authorization/host/x-*', async () => {
    const { stub, calls } = makeHttpRequestStub();
    const handler = createHandler({ upstreamSocketPath: UPSTREAM, httpRequest: stub });
    const req = makeReq({
      method: 'POST',
      url: '/git-token',
      headers: {
        host: 'github.com',
        authorization: 'Bearer evil',
        'x-real-ip': '1.2.3.4',
        cookie: 'a=b',
        'content-type': 'application/json',
        'content-length': '99', // lying value — must be overwritten
      },
    });
    const cap = makeRes();
    handler(req, cap.res);
    (req as PassThrough).write(Buffer.from('{}'));
    (req as PassThrough).end();
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1);
    const upstreamCall = calls[0]!;
    expect(upstreamCall.options).toMatchObject({
      socketPath: UPSTREAM,
      method: 'POST',
      path: '/git-token',
    });
    expect(upstreamCall.options.headers).toEqual({
      'content-type': 'application/json',
      'content-length': '2', // recomputed from buffered body
    });
    // Confirm forbidden headers absent
    const sent = upstreamCall.options.headers as Record<string, string>;
    expect(sent['host']).toBeUndefined();
    expect(sent['authorization']).toBeUndefined();
    expect(sent['x-real-ip']).toBeUndefined();
    expect(sent['cookie']).toBeUndefined();
  });
});

describe('createHandler — upstream success passthrough', () => {
  it('pipes upstream status, headers, and body verbatim on 200', async () => {
    const { stub, calls } = makeHttpRequestStub();
    const handler = createHandler({ upstreamSocketPath: UPSTREAM, httpRequest: stub });
    const req = makeReq({
      method: 'POST',
      url: '/git-token',
      headers: { 'content-type': 'application/json' },
    });
    const cap = makeRes();
    handler(req, cap.res);
    (req as PassThrough).write(Buffer.from('{}'));
    (req as PassThrough).end();
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1);
    calls[0]!.triggerResponse({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'opaque-token', expiresAt: '2026-06-05T16:34:12.000Z' }),
    });
    // Wait for upstream stream to pipe + 'end' to fire
    await new Promise((r) => setTimeout(r, 10));
    expect(cap.statusCode).toBe(200);
    expect(cap.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(cap.body)).toEqual({
      token: 'opaque-token',
      expiresAt: '2026-06-05T16:34:12.000Z',
    });
  });
});

describe('createHandler — upstream error path', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('responds 502 CONTROL_SOCKET_UNREACHABLE and logs once on upstream error', async () => {
    const { stub, calls } = makeHttpRequestStub();
    const handler = createHandler({ upstreamSocketPath: UPSTREAM, httpRequest: stub });
    const req = makeReq({
      method: 'POST',
      url: '/git-token',
      headers: { 'content-type': 'application/json' },
    });
    const cap = makeRes();
    handler(req, cap.res);
    (req as PassThrough).write(Buffer.from('{}'));
    (req as PassThrough).end();
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1);
    calls[0]!.triggerError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    await new Promise((r) => setImmediate(r));
    expect(cap.statusCode).toBe(502);
    expect(JSON.parse(cap.body)).toEqual({
      error: 'control-plane upstream unreachable',
      code: 'CONTROL_SOCKET_UNREACHABLE',
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toBe(
      JSON.stringify({
        event: 'git-token-proxy-upstream-error',
        code: 'CONTROL_SOCKET_UNREACHABLE',
      }),
    );
  });
});
