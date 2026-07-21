import { describe, expect, it, vi } from 'vitest';
import { invokeGate } from '../client.js';
import type { GateClientOptions } from '../options.js';

function makeOptions(spy: typeof fetch, overrides: Partial<GateClientOptions> = {}): GateClientOptions {
  return {
    baseUrl: 'http://mock.local',
    timeoutMs: 5000,
    fetchImpl: spy,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown, extra: { text?: string } = {}): Response {
  const text = extra.text ?? (body === undefined ? '' : JSON.stringify(body));
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('invokeGate — R4 error mapping (#1022)', () => {
  it('2xx happy path returns ok envelope with parsed body', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gateId: 'g_1', status: 'open' }));
    const result = await invokeGate<{ gateId: string; status: string }>(
      { method: 'POST', path: '/cockpit/gates', body: { kind: 'x' } },
      makeOptions(spy as unknown as typeof fetch),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data).toEqual({ gateId: 'g_1', status: 'open' });
  });

  it('HTTP 400 → invalid-args', async () => {
    const spy = vi.fn(async () => jsonResponse(400, undefined, { text: 'bad shape' }));
    const result = await invokeGate(
      { method: 'POST', path: '/cockpit/gates', body: {} },
      makeOptions(spy as unknown as typeof fetch),
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(result.detail).toBe('bad shape');
  });

  it('HTTP 401 → internal', async () => {
    const spy = vi.fn(async () => jsonResponse(401, undefined, { text: 'unauth' }));
    const result = await invokeGate(
      { method: 'POST', path: '/cockpit/gates', body: {} },
      makeOptions(spy as unknown as typeof fetch),
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
  });

  it('HTTP 403 → internal', async () => {
    const spy = vi.fn(async () => jsonResponse(403, undefined, { text: 'forbidden' }));
    const result = await invokeGate(
      { method: 'POST', path: '/cockpit/gates', body: {} },
      makeOptions(spy as unknown as typeof fetch),
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
  });

  it('HTTP 404 → unknown-gate', async () => {
    const spy = vi.fn(async () => jsonResponse(404, undefined, { text: 'no such gate' }));
    const result = await invokeGate(
      { method: 'POST', path: '/cockpit/gates/g_1/ack', body: {} },
      makeOptions(spy as unknown as typeof fetch),
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('unknown-gate');
  });

  it('HTTP 405 → internal', async () => {
    const spy = vi.fn(async () => jsonResponse(405, undefined, { text: 'nope' }));
    const result = await invokeGate(
      { method: 'POST', path: '/cockpit/gates', body: {} },
      makeOptions(spy as unknown as typeof fetch),
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
  });

  it('HTTP 409 → invalid-args', async () => {
    const spy = vi.fn(async () => jsonResponse(409, undefined, { text: 'conflict' }));
    const result = await invokeGate(
      { method: 'POST', path: '/cockpit/gates', body: {} },
      makeOptions(spy as unknown as typeof fetch),
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('HTTP 410 → internal', async () => {
    const spy = vi.fn(async () => jsonResponse(410, undefined, { text: 'gone' }));
    const result = await invokeGate(
      { method: 'POST', path: '/cockpit/gates', body: {} },
      makeOptions(spy as unknown as typeof fetch),
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
  });

  it('HTTP 429 → internal', async () => {
    const spy = vi.fn(async () => jsonResponse(429, undefined, { text: 'slow down' }));
    const result = await invokeGate(
      { method: 'POST', path: '/cockpit/gates', body: {} },
      makeOptions(spy as unknown as typeof fetch),
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
  });

  it('HTTP 500 → transport', async () => {
    const spy = vi.fn(async () => jsonResponse(500, undefined, { text: 'boom' }));
    const result = await invokeGate(
      { method: 'POST', path: '/cockpit/gates', body: {} },
      makeOptions(spy as unknown as typeof fetch),
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('transport');
    expect(result.detail).toBe('boom');
  });

  it('HTTP 502 → transport', async () => {
    const spy = vi.fn(async () => jsonResponse(502, undefined, { text: 'bad gateway' }));
    const result = await invokeGate(
      { method: 'POST', path: '/cockpit/gates', body: {} },
      makeOptions(spy as unknown as typeof fetch),
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('transport');
  });

  it('HTTP 503 → transport', async () => {
    const spy = vi.fn(async () => jsonResponse(503, undefined, { text: 'unavailable' }));
    const result = await invokeGate(
      { method: 'POST', path: '/cockpit/gates', body: {} },
      makeOptions(spy as unknown as typeof fetch),
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('transport');
  });

  it('network error (fetchImpl throws) → transport', async () => {
    const spy = vi.fn(async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:3100');
    });
    const result = await invokeGate(
      { method: 'POST', path: '/cockpit/gates', body: {} },
      makeOptions(spy as unknown as typeof fetch),
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('transport');
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('timeout (AbortController fires) → transport with timed-out detail', async () => {
    const spy = vi.fn(async (_url: string, opts?: RequestInit) => {
      await new Promise<never>((_, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
      throw new Error('unreachable');
    });
    const result = await invokeGate(
      { method: 'POST', path: '/cockpit/gates', body: {} },
      makeOptions(spy as unknown as typeof fetch, { timeoutMs: 10 }),
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('transport');
    expect(result.detail).toMatch(/timed out after 10ms/);
  });

  it('2xx with non-JSON body → internal', async () => {
    const spy = vi.fn(
      async () => new Response('not-json {', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const result = await invokeGate(
      { method: 'POST', path: '/cockpit/gates', body: {} },
      makeOptions(spy as unknown as typeof fetch),
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
    expect(result.detail).toContain('non-JSON');
  });

  it('builds absolute URL from baseUrl + path', async () => {
    const spy = vi.fn(async () => jsonResponse(200, {}));
    await invokeGate(
      { method: 'POST', path: '/cockpit/gates', body: {} },
      makeOptions(spy as unknown as typeof fetch, { baseUrl: 'http://mock.local:9000' }),
    );
    const url = spy.mock.calls[0]?.[0];
    expect(url).toBe('http://mock.local:9000/cockpit/gates');
  });

  it('serializes JSON body and sets content-type header', async () => {
    const spy = vi.fn(async () => jsonResponse(200, {}));
    await invokeGate(
      { method: 'POST', path: '/cockpit/gates', body: { kind: 'a', n: 1 } },
      makeOptions(spy as unknown as typeof fetch),
    );
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ kind: 'a', n: 1 }));
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
  });
});
