import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  queryGateStatus,
  queryGateList,
  _setTestRetryBackoffs,
} from '../query-client.js';
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

const validStatusBody = { gateId: 'a'.repeat(24), status: 'open' };

describe('queryGateStatus — retry semantics (#1038 / INV-2)', () => {
  beforeEach(() => {
    // Zero out the backoff between attempts so tests don't sleep.
    _setTestRetryBackoffs([0, 0, 0]);
  });
  afterEach(() => {
    _setTestRetryBackoffs(null);
  });

  it('succeeds on first attempt with parsed response', async () => {
    const spy = vi.fn(async () => jsonResponse(200, validStatusBody));
    const result = await queryGateStatus(
      { issueRef: 'o/r#1', gateType: 'clarification', generation: 'g' },
      makeOptions(spy as unknown as typeof fetch),
    );
    if ('class' in result) throw new Error('expected success');
    expect(result).toEqual(validStatusBody);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('succeeds after 1 retry (attempt 1 = 503, attempt 2 = 200)', async () => {
    let call = 0;
    const spy = vi.fn(async () => {
      call++;
      if (call === 1) return jsonResponse(503, undefined, { text: 'temporarily unavailable' });
      return jsonResponse(200, validStatusBody);
    });
    const result = await queryGateStatus(
      { issueRef: 'o/r#1', gateType: 'clarification', generation: 'g' },
      makeOptions(spy as unknown as typeof fetch),
    );
    if ('class' in result) throw new Error('expected success');
    expect(result).toEqual(validStatusBody);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('succeeds after 2 retries (attempts 1+2 = 503, attempt 3 = 200)', async () => {
    let call = 0;
    const spy = vi.fn(async () => {
      call++;
      if (call < 3) return jsonResponse(503, undefined, { text: 'down' });
      return jsonResponse(200, validStatusBody);
    });
    const result = await queryGateStatus(
      { issueRef: 'o/r#1', gateType: 'clarification', generation: 'g' },
      makeOptions(spy as unknown as typeof fetch),
    );
    if ('class' in result) throw new Error('expected success');
    expect(result).toEqual(validStatusBody);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('retry exhaustion (all 3 = 503) → query-unreachable', async () => {
    const spy = vi.fn(async () => jsonResponse(503, undefined, { text: 'down' }));
    const result = await queryGateStatus(
      { issueRef: 'o/r#1', gateType: 'clarification', generation: 'g' },
      makeOptions(spy as unknown as typeof fetch),
    );
    if (!('class' in result)) throw new Error('expected error');
    expect(result.class).toBe('query-unreachable');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('all 3 attempts network-error → query-unreachable (INV-2 never absent)', async () => {
    const spy = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await queryGateStatus(
      { issueRef: 'o/r#1', gateType: 'clarification', generation: 'g' },
      makeOptions(spy as unknown as typeof fetch),
    );
    if (!('class' in result)) throw new Error('expected error');
    expect(result.class).toBe('query-unreachable');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('HTTP 400 → invalid-args (no retry)', async () => {
    const spy = vi.fn(async () => jsonResponse(400, undefined, { text: 'bad' }));
    const result = await queryGateStatus(
      { issueRef: 'o/r#1', gateType: 'clarification', generation: 'g' },
      makeOptions(spy as unknown as typeof fetch),
    );
    if (!('class' in result)) throw new Error('expected error');
    expect(result.class).toBe('invalid-args');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('HTTP 200 with malformed body on all 3 → internal', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gateId: 'short', status: 'open' }));
    const result = await queryGateStatus(
      { issueRef: 'o/r#1', gateType: 'clarification', generation: 'g' },
      makeOptions(spy as unknown as typeof fetch),
    );
    if (!('class' in result)) throw new Error('expected error');
    expect(result.class).toBe('query-unreachable');
    // Malformed body is retryable — 3 attempts before terminal query-unreachable.
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('per-attempt AbortError treated as retryable transport failure', async () => {
    let call = 0;
    const spy = vi.fn(async () => {
      call++;
      if (call < 3) {
        const err: Error & { name: string } = new Error('abort');
        err.name = 'AbortError';
        throw err;
      }
      return jsonResponse(200, validStatusBody);
    });
    const result = await queryGateStatus(
      { issueRef: 'o/r#1', gateType: 'clarification', generation: 'g' },
      makeOptions(spy as unknown as typeof fetch),
    );
    if ('class' in result) throw new Error('expected success');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('URL construction — single mode includes gateType + generation', async () => {
    const spy = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/cockpit/gates');
      expect(url.searchParams.get('issueRef')).toBe('owner/repo#1');
      expect(url.searchParams.get('mode')).toBe('single');
      expect(url.searchParams.get('gateType')).toBe('clarification');
      expect(url.searchParams.get('generation')).toBe('gen-x');
      return jsonResponse(200, validStatusBody);
    });
    await queryGateStatus(
      { issueRef: 'owner/repo#1', gateType: 'clarification', generation: 'gen-x' },
      makeOptions(spy as unknown as typeof fetch),
    );
  });
});

describe('queryGateList — URL + retry (#1038)', () => {
  beforeEach(() => {
    _setTestRetryBackoffs([0, 0, 0]);
  });
  afterEach(() => {
    _setTestRetryBackoffs(null);
  });

  it('URL construction — list mode with gateType filter passthrough', async () => {
    const spy = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('mode')).toBe('list');
      expect(url.searchParams.get('gateType')).toBe('clarification');
      return jsonResponse(200, { gates: [] });
    });
    await queryGateList(
      { issueRef: 'o/r#1', gateType: 'clarification' },
      makeOptions(spy as unknown as typeof fetch),
    );
  });

  it('URL construction — list mode without gateType omits the param', async () => {
    const spy = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('mode')).toBe('list');
      expect(url.searchParams.has('gateType')).toBe(false);
      return jsonResponse(200, { gates: [] });
    });
    await queryGateList({ issueRef: 'o/r#1' }, makeOptions(spy as unknown as typeof fetch));
  });

  it('happy path returns list', async () => {
    const gates = [
      { gateId: 'a'.repeat(24), gateType: 'clarification', status: 'open' },
      { gateId: 'b'.repeat(24), gateType: 'implementation-review', status: 'answered' },
    ];
    const spy = vi.fn(async () => jsonResponse(200, { gates }));
    const result = await queryGateList(
      { issueRef: 'o/r#1' },
      makeOptions(spy as unknown as typeof fetch),
    );
    if ('class' in result) throw new Error('expected success');
    expect(result.gates).toEqual(gates);
  });

  it('empty list is a legal success (US3)', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gates: [] }));
    const result = await queryGateList(
      { issueRef: 'o/r#1' },
      makeOptions(spy as unknown as typeof fetch),
    );
    if ('class' in result) throw new Error('expected success');
    expect(result.gates).toEqual([]);
  });
});
