/**
 * Tests for `createGateQueryClient` (#1038 T033).
 *
 * Single-call contract: no retry inside the client. These tests pin:
 *   - URL shape (query-string encoding) for status + list modes
 *   - 200 JSON parses through the response schemas
 *   - 400 → QueryInvalidArgsError
 *   - 5xx → QueryTransportError
 *   - other 4xx → QueryInternalError
 *   - network error → QueryTransportError
 *   - 2xx with malformed body → QueryInternalError
 *   - AbortController fires on timeout
 *   - fetchImpl invoked exactly once per client call
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createGateQueryClient,
  QueryInvalidArgsError,
  QueryTransportError,
  QueryInternalError,
} from '../query-client.js';

function jsonResponse(status: number, body: unknown, text?: string): Response {
  return new Response(text ?? (body === undefined ? '' : JSON.stringify(body)), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const BASE = { baseUrl: 'http://mock.local', timeoutMs: 5000 };
const GATE_ID = 'a'.repeat(24);

describe('createGateQueryClient — URL shape', () => {
  it('status mode: encodes issueRef, gateType, generation', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gateId: GATE_ID, status: 'open' }));
    const client = createGateQueryClient({ ...BASE, fetchImpl: spy });
    await client.getGateStatus({
      issueRef: 'gen-ai/repo#38',
      gateType: 'clarification',
      generation: 'abc123def456',
    });
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('/cockpit/gates?');
    expect(url).toContain('issueRef=gen-ai%2Frepo%2338');
    expect(url).toContain('gateType=clarification');
    expect(url).toContain('generation=abc123def456');
  });

  it('list mode: encodes issueRef and optional gateType, omits generation', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gates: [] }));
    const client = createGateQueryClient({ ...BASE, fetchImpl: spy });
    await client.listGates({ issueRef: 'gen-ai/repo#38', gateType: 'clarification' });
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('issueRef=gen-ai%2Frepo%2338');
    expect(url).toContain('gateType=clarification');
    expect(url).not.toContain('generation=');
  });

  it('list mode without gateType: only issueRef', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gates: [] }));
    const client = createGateQueryClient({ ...BASE, fetchImpl: spy });
    await client.listGates({ issueRef: 'gen-ai/repo#38' });
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('issueRef=gen-ai%2Frepo%2338');
    expect(url).not.toContain('gateType=');
    expect(url).not.toContain('generation=');
  });
});

describe('createGateQueryClient — response parsing', () => {
  it('status 200 open → parsed data', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gateId: GATE_ID, status: 'open' }));
    const client = createGateQueryClient({ ...BASE, fetchImpl: spy });
    const result = await client.getGateStatus({
      issueRef: 'g/r#1',
      gateType: 'clarification',
      generation: 'x',
    });
    expect(result).toEqual({ gateId: GATE_ID, status: 'open' });
  });

  it('status 200 absent → { gateId: null, status: "absent" }', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gateId: null, status: 'absent' }));
    const client = createGateQueryClient({ ...BASE, fetchImpl: spy });
    const result = await client.getGateStatus({
      issueRef: 'g/r#1',
      gateType: 'clarification',
      generation: 'x',
    });
    expect(result).toEqual({ gateId: null, status: 'absent' });
  });

  it('list 200 → { gates: [...], truncated? }', async () => {
    const gate = {
      gateId: GATE_ID,
      gateType: 'clarification' as const,
      generation: 'gen-1',
      status: 'open' as const,
    };
    const spy = vi.fn(async () => jsonResponse(200, { gates: [gate], truncated: true }));
    const client = createGateQueryClient({ ...BASE, fetchImpl: spy });
    const result = await client.listGates({ issueRef: 'g/r#1' });
    expect(result.gates).toEqual([gate]);
    expect(result.truncated).toBe(true);
  });
});

describe('createGateQueryClient — error mapping', () => {
  it('400 → QueryInvalidArgsError', async () => {
    const spy = vi.fn(async () => jsonResponse(400, undefined, 'bad shape'));
    const client = createGateQueryClient({ ...BASE, fetchImpl: spy });
    await expect(
      client.getGateStatus({ issueRef: 'g/r#1', gateType: 'clarification', generation: 'x' }),
    ).rejects.toBeInstanceOf(QueryInvalidArgsError);
  });

  it.each([500, 502, 503, 504])('%s → QueryTransportError', async (status) => {
    const spy = vi.fn(async () => jsonResponse(status, undefined, 'boom'));
    const client = createGateQueryClient({ ...BASE, fetchImpl: spy });
    await expect(
      client.getGateStatus({ issueRef: 'g/r#1', gateType: 'clarification', generation: 'x' }),
    ).rejects.toBeInstanceOf(QueryTransportError);
  });

  it.each([401, 403, 404, 405, 422, 429])(
    'other 4xx (%s) → QueryInternalError',
    async (status) => {
      const spy = vi.fn(async () => jsonResponse(status, undefined, 'bad'));
      const client = createGateQueryClient({ ...BASE, fetchImpl: spy });
      await expect(
        client.getGateStatus({ issueRef: 'g/r#1', gateType: 'clarification', generation: 'x' }),
      ).rejects.toBeInstanceOf(QueryInternalError);
    },
  );

  it('network error → QueryTransportError', async () => {
    const spy = vi.fn(async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:3100');
    });
    const client = createGateQueryClient({ ...BASE, fetchImpl: spy });
    await expect(
      client.getGateStatus({ issueRef: 'g/r#1', gateType: 'clarification', generation: 'x' }),
    ).rejects.toBeInstanceOf(QueryTransportError);
  });

  it('2xx with non-JSON body → QueryInternalError', async () => {
    const spy = vi.fn(async () => new Response('not-json', { status: 200 }));
    const client = createGateQueryClient({ ...BASE, fetchImpl: spy });
    await expect(
      client.getGateStatus({ issueRef: 'g/r#1', gateType: 'clarification', generation: 'x' }),
    ).rejects.toBeInstanceOf(QueryInternalError);
  });

  it('2xx with malformed envelope → QueryInternalError', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { status: 'open' /* missing gateId */ }));
    const client = createGateQueryClient({ ...BASE, fetchImpl: spy });
    await expect(
      client.getGateStatus({ issueRef: 'g/r#1', gateType: 'clarification', generation: 'x' }),
    ).rejects.toBeInstanceOf(QueryInternalError);
  });

  it('AbortController timeout → QueryTransportError with `timed out` message', async () => {
    const spy = vi.fn(async (_url: string, opts?: RequestInit) => {
      await new Promise<never>((_, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
      throw new Error('unreachable');
    });
    const client = createGateQueryClient({
      baseUrl: 'http://mock.local',
      timeoutMs: 10,
      fetchImpl: spy as unknown as typeof fetch,
    });
    const err = await client
      .getGateStatus({ issueRef: 'g/r#1', gateType: 'clarification', generation: 'x' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(QueryTransportError);
    expect((err as QueryTransportError).message).toMatch(/timed out after 10ms/);
  });
});

describe('createGateQueryClient — single-call contract (no retry)', () => {
  it('fetchImpl is invoked exactly once per getGateStatus call', async () => {
    const spy = vi.fn(async () => jsonResponse(500, undefined, 'boom'));
    const client = createGateQueryClient({ ...BASE, fetchImpl: spy });
    await client
      .getGateStatus({ issueRef: 'g/r#1', gateType: 'clarification', generation: 'x' })
      .catch(() => {});
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fetchImpl is invoked exactly once per listGates call', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gates: [] }));
    const client = createGateQueryClient({ ...BASE, fetchImpl: spy });
    await client.listGates({ issueRef: 'g/r#1' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
