/**
 * Parity tests for `cockpit_gate_list` (#1038).
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { cockpitGateList } from '../tools/cockpit_gate_list.js';
import { CockpitGateListInputSchema } from '../gates/query-schemas.js';

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

const GATE_ID_A = 'a'.repeat(24);
const GATE_ID_B = 'b'.repeat(24);

const CANONICAL_INPUT: Record<string, unknown> = {
  issueRef: 'generacy-ai/generacy#1038',
};

describe('cockpit_gate_list parity (#1038)', () => {
  it('empty list → { gates: [] } is SUCCESS envelope (not error)', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gates: [] }));
    const result = await cockpitGateList(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.gates).toEqual([]);
    expect('truncated' in result.data).toBe(false);
  });

  it('single-entry list', async () => {
    const gate = {
      gateId: GATE_ID_A,
      gateType: 'clarification' as const,
      generation: 'g1',
      status: 'open' as const,
    };
    const spy = vi.fn(async () => jsonResponse(200, { gates: [gate] }));
    const result = await cockpitGateList(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.gates).toEqual([gate]);
  });

  it('many-entry list', async () => {
    const gates = [
      { gateId: GATE_ID_A, gateType: 'clarification' as const, generation: 'g1', status: 'open' as const },
      {
        gateId: GATE_ID_B,
        gateType: 'implementation-review' as const,
        generation: 'sha123',
        status: 'answered' as const,
      },
    ];
    const spy = vi.fn(async () => jsonResponse(200, { gates }));
    const result = await cockpitGateList(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.gates).toHaveLength(2);
  });

  it('gateType filter narrows list — forwarded to URL', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gates: [] }));
    await cockpitGateList(
      { ...CANONICAL_INPUT, gateType: 'clarification' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('gateType=clarification');
  });

  it('truncated:true passes through when present', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gates: [], truncated: true }));
    const result = await cockpitGateList(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.truncated).toBe(true);
  });

  it('truncated absent (not false) when list is complete', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gates: [] }));
    const result = await cockpitGateList(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect('truncated' in result.data).toBe(false);
  });

  it('retry exhaustion → class:"query-unreachable"', async () => {
    const spy = vi.fn(async () => jsonResponse(502, undefined, 'gateway'));
    const result = await cockpitGateList(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('query-unreachable');
    expect(spy).toHaveBeenCalledTimes(3);
  }, 10_000);

  it('input .strict() — typo `issue_ref` rejected', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gates: [] }));
    const result = await cockpitGateList(
      { issue_ref: 'g/r#1' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });

  it('input .strict() — unknown gateType rejected', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gates: [] }));
    const result = await cockpitGateList(
      { issueRef: 'g/r#1', gateType: 'not-a-real-type' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });

  it('400 → class:"invalid-args" (no retry)', async () => {
    const spy = vi.fn(async () => jsonResponse(400, undefined, 'bad'));
    const result = await cockpitGateList(CANONICAL_INPUT, {
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
    const result = await cockpitGateList(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('200 with missing gates array → class:"internal"', async () => {
    const spy = vi.fn(async () => jsonResponse(200, {}));
    const result = await cockpitGateList(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
  });

  // -------------------------------------------------------------------
  // #1067 — runId widening on CockpitGateListInputSchema (US1, US5).
  // Accepted on the MCP surface for parity with cockpit_gate_status;
  // DROPPED by the handler before the client call (see cockpit_gate_list.ts).
  // -------------------------------------------------------------------
  describe('#1067 — CockpitGateListInputSchema runId widening', () => {
    it('SC-006: inputSchema stays a flat z.object with non-empty properties (not z.intersection)', () => {
      expect(CockpitGateListInputSchema).toBeInstanceOf(z.ZodObject);
      const shape = (CockpitGateListInputSchema as z.ZodObject<z.ZodRawShape>).shape;
      const keys = Object.keys(shape);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys).toContain('issueRef');
    });

    it('widened-shape acceptance: {issueRef, gateType?, runId?} validates', () => {
      const parsed = CockpitGateListInputSchema.safeParse({
        issueRef: 'generacy-ai/generacy#1067',
        gateType: 'implementation-review',
        runId: 'auto-cluster-1067-1722243247891',
      });
      expect(parsed.success).toBe(true);
    });

    it('SC-002 legacy byte-compat: {issueRef, gateType?} validates and parsed data has no runId property', () => {
      const parsed = CockpitGateListInputSchema.safeParse({
        issueRef: 'generacy-ai/generacy#1067',
        gateType: 'implementation-review',
      });
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect('runId' in parsed.data).toBe(false);
      expect(parsed.data).toEqual({
        issueRef: 'generacy-ai/generacy#1067',
        gateType: 'implementation-review',
      });
    });

    it('typo-guard: {..., run_id: "oops"} is rejected with unrecognized_keys (.strict() boundary preserved)', () => {
      const parsed = CockpitGateListInputSchema.safeParse({
        issueRef: 'generacy-ai/generacy#1067',
        gateType: 'implementation-review',
        run_id: 'oops',
      });
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      const codes = parsed.error.issues.map((i) => i.code);
      expect(codes).toContain('unrecognized_keys');
    });

    it('handler drops runId before the client call — outbound URL never carries runId', async () => {
      const spy = vi.fn(async () => jsonResponse(200, { gates: [] }));
      await cockpitGateList(
        {
          issueRef: 'generacy-ai/generacy#1067',
          gateType: 'implementation-review',
          runId: 'auto-cluster-1067-1722243247891',
        },
        { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
      );
      const url = String(spy.mock.calls[0]?.[0]);
      expect(url).not.toContain('runId=');
      expect(url).not.toContain('run_id=');
    });
  });
});
