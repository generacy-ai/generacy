/**
 * Parity tests for `cockpit_gate_ack` (#1022 / #843) — the FROZEN wire contract.
 *
 * The tool now emits a gate-outcome record (Shape 2, THE ACK): a flat
 * { type:'gate-outcome', gateId, outcome, detail?, at } frame with a CLOSED
 * outcome enum ('applied' | 'superseded' | 'failed'). These tests pin that
 * frozen shape — they REPLACE the prior #1033/#1035 pins that asserted the WRONG
 * gate-ack (`kind`/`ackedAt`/`generation`, free-string `outcome`).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { cockpitGateAck } from '../tools/cockpit_gate_ack.js';

function jsonResponse(status: number, body: unknown, text?: string): Response {
  return new Response(text ?? (body === undefined ? '' : JSON.stringify(body)), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bodyOf(spy: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = spy.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

const BASE_DEPS = {
  orchestratorUrl: 'http://mock.local',
  orchestratorTimeoutMs: 5000,
};

// A real 24-char hex gateId (as `deriveGateId` would produce).
const GATE_ID = createHash('sha256')
  .update('generacy-ai/generacy#1022:clarification:batch-1', 'utf8')
  .digest('hex')
  .slice(0, 24);

const CANONICAL_INPUT = {
  gateId: GATE_ID,
  outcome: 'applied' as const,
};

describe('cockpit_gate_ack parity — frozen gate-outcome (#1022/#843)', () => {
  it('emits a gate-outcome frame to /ack and returns the orchestrator body', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { ok: true }));
    const result = await cockpitGateAck(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data).toEqual({ ok: true });

    expect(spy.mock.calls[0]?.[0]).toBe(`http://mock.local/cockpit/gates/${GATE_ID}/ack`);

    const body = bodyOf(spy);
    expect(body.type).toBe('gate-outcome');
    expect(body.gateId).toBe(GATE_ID);
    expect(body.outcome).toBe('applied');
    expect(typeof body.at).toBe('string');
    expect(Number.isNaN(Date.parse(body.at as string))).toBe(false);
    expect(body).not.toHaveProperty('detail');

    // The old WRONG gate-ack shape must NOT leak onto the wire.
    expect(body).not.toHaveProperty('kind');
    expect(body).not.toHaveProperty('generation');
    expect(body).not.toHaveProperty('ackedAt');
  });

  it('forwards detail + explicit at verbatim', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { ok: true }));
    const input = {
      gateId: GATE_ID,
      outcome: 'superseded' as const,
      detail: 're-opened as a new generation',
      at: '2026-07-22T12:00:00.000Z',
    };
    const result = await cockpitGateAck(input, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    expect(bodyOf(spy)).toEqual({
      type: 'gate-outcome',
      gateId: GATE_ID,
      outcome: 'superseded',
      detail: 're-opened as a new generation',
      at: '2026-07-22T12:00:00.000Z',
    });
  });

  it("accepts outcome 'failed'", async () => {
    const spy = vi.fn(async () => jsonResponse(200, {}));
    const result = await cockpitGateAck(
      { gateId: GATE_ID, outcome: 'failed' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('ok');
    expect(bodyOf(spy).outcome).toBe('failed');
  });

  it('rejects an off-enum outcome (e.g. legacy "approved") → class: invalid-args', async () => {
    const spy = vi.fn(async () => jsonResponse(200, {}));
    const result = await cockpitGateAck(
      { gateId: GATE_ID, outcome: 'approved' } as unknown,
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });

  it('missing gateId → class: invalid-args', async () => {
    const spy = vi.fn(async () => jsonResponse(200, {}));
    const result = await cockpitGateAck({ outcome: 'applied' } as unknown, {
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
    const result = await cockpitGateAck({ gateId: GATE_ID } as unknown, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });

  it('gateId not 24 hex chars → class: invalid-args', async () => {
    const spy = vi.fn(async () => jsonResponse(200, {}));
    const result = await cockpitGateAck({ gateId: 'g_1', outcome: 'applied' } as unknown, {
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
      { ...CANONICAL_INPUT, generation: 3 } as unknown,
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
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

  it('HTTP 401 → class: internal', async () => {
    const spy = vi.fn(async () => jsonResponse(401, undefined, 'unauth'));
    const result = await cockpitGateAck(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
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
});
