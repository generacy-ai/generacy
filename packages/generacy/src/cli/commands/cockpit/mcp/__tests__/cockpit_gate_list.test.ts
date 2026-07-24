import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cockpitGateList } from '../tools/cockpit_gate_list.js';
import { _setTestRetryBackoffs } from '../gates/query-client.js';

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

const THREE_GATES = [
  { gateId: 'a'.repeat(24), gateType: 'clarification', status: 'open' },
  { gateId: 'b'.repeat(24), gateType: 'implementation-review', status: 'answered' },
  { gateId: 'c'.repeat(24), gateType: 'artifact-review', status: 'open' },
];

describe('cockpit_gate_list (#1038)', () => {
  beforeEach(() => {
    _setTestRetryBackoffs([0, 0, 0]);
  });
  afterEach(() => {
    _setTestRetryBackoffs(null);
  });

  it('happy path — cloud returns 3 gates → tool returns them all', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gates: THREE_GATES }));
    const result = await cockpitGateList(
      { issueRef: 'o/r#1' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.data.gates).toEqual(THREE_GATES);
  });

  it('empty list is a legal success (US3) — NO throw', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gates: [] }));
    const result = await cockpitGateList(
      { issueRef: 'o/r#1' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.data.gates).toEqual([]);
  });

  it('client-side gateType filter — cloud returns 3 mixed types → tool filters to requested', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gates: THREE_GATES }));
    const result = await cockpitGateList(
      { issueRef: 'o/r#1', gateType: 'clarification' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.data.gates).toHaveLength(1);
    expect(result.data.gates[0].gateType).toBe('clarification');
  });

  it("cloud row with status='answered' is preserved (delivered mapped upstream)", async () => {
    const spy = vi.fn(async () =>
      jsonResponse(200, {
        gates: [
          { gateId: 'a'.repeat(24), gateType: 'clarification', status: 'answered' },
        ],
      }),
    );
    const result = await cockpitGateList(
      { issueRef: 'o/r#1' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.data.gates[0].status).toBe('answered');
  });

  it('missing issueRef → invalid-args', async () => {
    const result = await cockpitGateList({}, { ...BASE_DEPS });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('unknown gateType enum → invalid-args', async () => {
    const result = await cockpitGateList(
      { issueRef: 'o/r#1', gateType: 'not-a-gate-type' },
      { ...BASE_DEPS },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('retry success — attempts 1+2 fail, attempt 3 succeeds → ok', async () => {
    let call = 0;
    const spy = vi.fn(async () => {
      call++;
      if (call < 3) return jsonResponse(503);
      return jsonResponse(200, { gates: [] });
    });
    const result = await cockpitGateList(
      { issueRef: 'o/r#1' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('retry exhaustion (all 503) → query-unreachable', async () => {
    const spy = vi.fn(async () => jsonResponse(503));
    const result = await cockpitGateList(
      { issueRef: 'o/r#1' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.class).toBe('query-unreachable');
  });

  it('never-empty-list guarantee on transport failure — all 3 network-error → query-unreachable', async () => {
    const spy = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await cockpitGateList(
      { issueRef: 'o/r#1' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.class).toBe('query-unreachable');
    // Prove we did NOT return `data: { gates: [] }`.
    expect((result as unknown as { data?: unknown }).data).toBeUndefined();
  });

  it('malformed item (status=foo) → query-unreachable', async () => {
    const spy = vi.fn(async () =>
      jsonResponse(200, {
        gates: [{ gateId: 'a'.repeat(24), gateType: 'clarification', status: 'foo' }],
      }),
    );
    const result = await cockpitGateList(
      { issueRef: 'o/r#1' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.class).toBe('query-unreachable');
  });
});
