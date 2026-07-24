/**
 * Parity tests for `cockpit_gate_status` (#1038).
 *
 * MCP-boundary tests: drive the tool through the `fetchImpl` injection seam
 * so no real HTTP call is made. Mirrors `parity-gate-open.test.ts` /
 * `parity-gate-ack.test.ts` shape from #1022.
 */
import { describe, it, expect, vi } from 'vitest';
import { cockpitGateStatus } from '../tools/cockpit_gate_status.js';

function jsonResponse(status: number, body: unknown, text?: string): Response {
  return new Response(text ?? (body === undefined ? '' : JSON.stringify(body)), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const BASE_DEPS = {
  orchestratorUrl: 'http://mock.local',
  orchestratorTimeoutMs: 5000,
};

const GATE_ID = 'a'.repeat(24);

const CANONICAL_INPUT: Record<string, unknown> = {
  issueRef: 'generacy-ai/generacy#1038',
  gateType: 'clarification',
  generation: 'abc123def456',
};

describe('cockpit_gate_status parity (#1038)', () => {
  // ---- happy paths ---------------------------------------------------

  it('open — { gateId, status:"open" } round-trips through the tool boundary', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gateId: GATE_ID, status: 'open' }));
    const result = await cockpitGateStatus(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data).toEqual({ gateId: GATE_ID, status: 'open' });
    // GET request, /cockpit/gates query-string carries all three fields.
    expect(spy).toHaveBeenCalledTimes(1);
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('/cockpit/gates?');
    expect(url).toContain('issueRef=generacy-ai%2Fgeneracy%231038');
    expect(url).toContain('gateType=clarification');
    expect(url).toContain('generation=abc123def456');
    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe('GET');
  });

  it('answered — { gateId, status:"answered" } round-trips', async () => {
    const spy = vi.fn(async () =>
      jsonResponse(200, { gateId: GATE_ID, status: 'answered' }),
    );
    const result = await cockpitGateStatus(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data).toEqual({ gateId: GATE_ID, status: 'answered' });
  });

  it('absent — { gateId: null, status:"absent" } is a SUCCESS envelope (FR-013)', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gateId: null, status: 'absent' }));
    const result = await cockpitGateStatus(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok'); // NOT 'error'
    if (result.status !== 'ok') return;
    expect(result.data.gateId).toBeNull();
    expect(result.data.status).toBe('absent');
    // Must not be confusable with an error envelope.
    expect((result as unknown as Record<string, unknown>)['class']).toBeUndefined();
  });

  // ---- retry / transport ---------------------------------------------

  it('transient 502 succeeds on retry attempt 2', async () => {
    const responses = [
      jsonResponse(502, undefined, 'boom'),
      jsonResponse(200, { gateId: GATE_ID, status: 'open' }),
    ];
    const spy = vi.fn(async () => responses.shift()!);
    const result = await cockpitGateStatus(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('retry exhaustion → class:"query-unreachable" with hint', async () => {
    const spy = vi.fn(async () => jsonResponse(503, undefined, 'gateway'));
    const result = await cockpitGateStatus(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('query-unreachable');
    expect(result.hint).toMatch(/connectivity/);
    expect(spy).toHaveBeenCalledTimes(3); // 3 attempts (initial + 2 retries)
  }, 10_000);

  it('network error retry exhaustion → class:"query-unreachable"', async () => {
    const spy = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await cockpitGateStatus(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('query-unreachable');
  }, 10_000);

  // ---- terminal error branches ---------------------------------------

  it('400 → class:"invalid-args" (no retry)', async () => {
    const spy = vi.fn(async () => jsonResponse(400, undefined, 'bad shape'));
    const result = await cockpitGateStatus(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('500 → class:"internal" (no retry, NOT query-unreachable)', async () => {
    // End-to-end guard for the review fix: a route 500 (deterministic
    // CloudRequestError) must surface as `internal` WITHOUT burning the
    // 3-attempt retry budget — proving 500 is not conflated with a transient
    // cloud outage at the tool boundary.
    const spy = vi.fn(async () => jsonResponse(500, undefined, 'route bug'));
    const result = await cockpitGateStatus(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('200 with malformed body → class:"internal"', async () => {
    const spy = vi.fn(async () => new Response('not-json', { status: 200 }));
    const result = await cockpitGateStatus(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
  });

  it('200 with missing gateId field → class:"internal"', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { status: 'open' /* no gateId */ }));
    const result = await cockpitGateStatus(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
  });

  // ---- input schema (.strict()) --------------------------------------

  it('input .strict() — typo `issue_ref` → class:"invalid-args" (no HTTP call)', async () => {
    const spy = vi.fn(async () => jsonResponse(200, {}));
    const result = await cockpitGateStatus(
      { issue_ref: 'g/r#1', gateType: 'clarification', generation: 'x' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });

  it('input .strict() — typo `gate_type` → class:"invalid-args" (no HTTP call)', async () => {
    const spy = vi.fn(async () => jsonResponse(200, {}));
    const result = await cockpitGateStatus(
      { issueRef: 'g/r#1', gate_type: 'clarification', generation: 'x' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });

  it('input .strict() — unknown gateType → class:"invalid-args"', async () => {
    const spy = vi.fn(async () => jsonResponse(200, {}));
    const result = await cockpitGateStatus(
      { issueRef: 'g/r#1', gateType: 'not-a-real-type', generation: 'x' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });

  it('numeric generation is accepted (coerced to string on wire)', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gateId: GATE_ID, status: 'open' }));
    const result = await cockpitGateStatus(
      { issueRef: 'g/r#1', gateType: 'phase-queue', generation: 2 },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('ok');
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('generation=2');
  });
});
