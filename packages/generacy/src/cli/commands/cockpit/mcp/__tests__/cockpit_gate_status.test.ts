import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cockpitGateStatus } from '../tools/cockpit_gate_status.js';
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

describe('cockpit_gate_status (#1038)', () => {
  beforeEach(() => {
    _setTestRetryBackoffs([0, 0, 0]);
  });
  afterEach(() => {
    _setTestRetryBackoffs(null);
  });

  it("happy path — cloud returns 'open' → tool returns ok+open", async () => {
    const spy = vi.fn(async () =>
      jsonResponse(200, { gateId: 'a'.repeat(24), status: 'open' }),
    );
    const result = await cockpitGateStatus(
      { issueRef: 'o/r#1', gateType: 'clarification', generation: 'g' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.status).toBe('open');
  });

  it("happy path — cloud returns 'absent' → tool returns ok+absent", async () => {
    const spy = vi.fn(async () =>
      jsonResponse(200, { gateId: 'a'.repeat(24), status: 'absent' }),
    );
    const result = await cockpitGateStatus(
      { issueRef: 'o/r#1', gateType: 'clarification', generation: 'g' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.data.status).toBe('absent');
  });

  it("cloud returns 'answered' (mapped from applied/delivered) → tool returns answered", async () => {
    const spy = vi.fn(async () =>
      jsonResponse(200, { gateId: 'a'.repeat(24), status: 'answered' }),
    );
    const result = await cockpitGateStatus(
      { issueRef: 'o/r#1', gateType: 'clarification', generation: 'g' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.data.status).toBe('answered');
  });

  it('missing issueRef → invalid-args', async () => {
    const result = await cockpitGateStatus(
      { gateType: 'clarification', generation: 'g' },
      { ...BASE_DEPS },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('extra field → invalid-args (strict schema)', async () => {
    const result = await cockpitGateStatus(
      { issueRef: 'o/r#1', gateType: 'clarification', generation: 'g', foo: 'bar' },
      { ...BASE_DEPS },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('unknown gateType enum → invalid-args', async () => {
    const result = await cockpitGateStatus(
      { issueRef: 'o/r#1', gateType: 'not-a-gate-type', generation: 'g' },
      { ...BASE_DEPS },
    );
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.class).toBe('invalid-args');
  });

  it('retry success — attempts 1+2 = 503, attempt 3 = 200 → ok', async () => {
    let call = 0;
    const spy = vi.fn(async () => {
      call++;
      if (call < 3) return jsonResponse(503);
      return jsonResponse(200, { gateId: 'a'.repeat(24), status: 'open' });
    });
    const result = await cockpitGateStatus(
      { issueRef: 'o/r#1', gateType: 'clarification', generation: 'g' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('retry exhaustion (all 503) → query-unreachable', async () => {
    const spy = vi.fn(async () => jsonResponse(503));
    const result = await cockpitGateStatus(
      { issueRef: 'o/r#1', gateType: 'clarification', generation: 'g' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.class).toBe('query-unreachable');
  });

  it('never-absent guarantee — all 3 network-error → query-unreachable (not absent)', async () => {
    const spy = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await cockpitGateStatus(
      { issueRef: 'o/r#1', gateType: 'clarification', generation: 'g' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.class).toBe('query-unreachable');
    // Belt-and-suspenders: prove we did NOT return `data: { status: 'absent' }`.
    expect((result as unknown as { data?: unknown }).data).toBeUndefined();
  });

  it('malformed cloud payload (short gateId) → query-unreachable via retry-then-terminal', async () => {
    // Malformed 200 bodies are treated as retryable transport-like failures
    // (per contracts/cockpit_gate_status.md); after 3 attempts, they surface
    // as query-unreachable (never as data.status='absent'). This preserves
    // INV-2 while keeping response-validation failures caller-visible.
    const spy = vi.fn(async () => jsonResponse(200, { gateId: 'short', status: 'open' }));
    const result = await cockpitGateStatus(
      { issueRef: 'o/r#1', gateType: 'clarification', generation: 'g' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.class).toBe('query-unreachable');
  });
});
