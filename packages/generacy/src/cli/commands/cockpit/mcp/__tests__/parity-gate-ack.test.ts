/**
 * Parity tests for `cockpit_gate_ack` (#1022) — 13 rows in
 * contracts/cockpit_gate_ack.md § "Test surface".
 */
import { describe, expect, it, vi } from 'vitest';
import { cockpitGateAck } from '../tools/cockpit_gate_ack.js';

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

const CANONICAL_INPUT = {
  gateId: 'gate_01HK7Z',
  generation: 1,
  outcome: 'approved',
};

describe('cockpit_gate_ack parity (#1022)', () => {
  it('happy 200 with JSON body → ok envelope with orchestrator body', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { ackId: 'a_1', accepted: true }));
    const result = await cockpitGateAck(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data).toEqual({ ackId: 'a_1', accepted: true });
  });

  it('2xx with non-JSON body → class: internal', async () => {
    const spy = vi.fn(async () => jsonResponse(200, undefined, 'not-json {'));
    const result = await cockpitGateAck(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
  });

  it('missing gateId → class: invalid-args', async () => {
    const spy = vi.fn(async () => jsonResponse(200, {}));
    const result = await cockpitGateAck({ outcome: 'approved' } as unknown, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });

  it('missing outcome → class: invalid-args', async () => {
    const spy = vi.fn(async () => jsonResponse(200, {}));
    const result = await cockpitGateAck({ gateId: 'g_1' } as unknown, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });

  it('empty gateId → class: invalid-args', async () => {
    const spy = vi.fn(async () => jsonResponse(200, {}));
    const result = await cockpitGateAck({ gateId: '', outcome: 'approved' }, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });

  it('extra key (strict-mode rejection) → class: invalid-args', async () => {
    const spy = vi.fn(async () => jsonResponse(200, {}));
    const result = await cockpitGateAck(
      { ...CANONICAL_INPUT, gate_id: 'g_typo' } as unknown,
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });

  it('HTTP 400 → class: invalid-args', async () => {
    const spy = vi.fn(async () => jsonResponse(400, undefined, 'bad ack'));
    const result = await cockpitGateAck(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('HTTP 404 → class: unknown-gate', async () => {
    const spy = vi.fn(async () => jsonResponse(404, undefined, 'no such gate'));
    const result = await cockpitGateAck(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('unknown-gate');
  });

  it('HTTP 409 → class: invalid-args', async () => {
    const spy = vi.fn(async () => jsonResponse(409, undefined, 'conflict'));
    const result = await cockpitGateAck(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('HTTP 500 → class: transport', async () => {
    const spy = vi.fn(async () => jsonResponse(500, undefined, 'boom'));
    const result = await cockpitGateAck(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('transport');
  });

  it('network error → class: transport', async () => {
    const spy = vi.fn(async () => {
      throw new Error('ENOTFOUND mock.local');
    });
    const result = await cockpitGateAck(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('transport');
  });

  it('timeout → class: transport, detail mentions timeout', async () => {
    const spy = vi.fn(async (_url: string, opts?: RequestInit) => {
      await new Promise<never>((_, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
      throw new Error('unreachable');
    });
    const result = await cockpitGateAck(CANONICAL_INPUT, {
      orchestratorUrl: 'http://mock.local',
      orchestratorTimeoutMs: 15,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('transport');
    expect(result.detail).toMatch(/timed out after 15ms/);
  });

  it('detail present + happy path → wire body carries outcome + detail (in the full envelope)', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { ok: true }));
    const input = { gateId: 'g_5', generation: 1, outcome: 'approved', detail: 'batch 1 answers look correct' };
    const result = await cockpitGateAck(input, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    // Verify the URL includes the encoded gateId.
    expect(spy.mock.calls[0]?.[0]).toBe('http://mock.local/cockpit/gates/g_5/ack');
    // Verify the wire body carries outcome + detail (gateId travels in the path).
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.outcome).toBe('approved');
    expect(body.detail).toBe('batch 1 answers look correct');
    expect(body.gateId).toBeUndefined();
  });

  it('encodes gateId in URL path', async () => {
    const spy = vi.fn(async () => jsonResponse(200, {}));
    await cockpitGateAck({ gateId: 'g/with spaces', generation: 1, outcome: 'approved' }, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(spy.mock.calls[0]?.[0]).toBe('http://mock.local/cockpit/gates/g%2Fwith%20spaces/ack');
  });
});

describe('cockpit_gate_ack envelope (GateAckSchema reconciliation)', () => {
  // The orchestrator's authoritative GateAckSchema requires
  // { kind:'gate-ack', gateId, generation:number, outcome, ackedAt }.
  // The tool must build that full envelope from the caller's
  // { gateId, generation, outcome, detail? } — gateId in the path, kind +
  // ackedAt added here — or gate resolution 400s.
  it('POSTs a full envelope: kind=gate-ack, generation (number), outcome, ackedAt', async () => {
    let sentBody: unknown;
    const spy = vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return jsonResponse(200, { accepted: true });
    });
    const result = await cockpitGateAck(
      { gateId: 'g_1', generation: 3, outcome: 'applied', detail: 'ok' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('ok');
    const body = sentBody as Record<string, unknown>;
    expect(body.kind).toBe('gate-ack');
    expect(body.generation).toBe(3);
    expect(typeof body.generation).toBe('number');
    expect(body.outcome).toBe('applied');
    expect(typeof body.ackedAt).toBe('string');
    expect(body.detail).toBe('ok');
    // gateId travels in the path, not the body.
    expect(body.gateId).toBeUndefined();
  });

  it('missing generation → invalid-args (no fetch)', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { accepted: true }));
    const result = await cockpitGateAck(
      { gateId: 'g_1', outcome: 'applied' } as unknown,
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });
});
