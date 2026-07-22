/**
 * Parity tests for `cockpit_gate_open` (#1022) — MCP-boundary coverage of the
 * 11 rows in contracts/cockpit_gate_open.md § "Test surface".
 *
 * Injection pattern mirrors parity-claim.test.ts: build the tool with a spy
 * `fetchImpl` so no real HTTP call is made and no `global.fetch` monkey-patch
 * is needed.
 */
import { describe, expect, it, vi } from 'vitest';
import { cockpitGateOpen } from '../tools/cockpit_gate_open.js';
import { CockpitGateOpenInputSchema } from '../schemas.js';

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

// A realistic gate-open envelope matching the authoritative GateOpenSchema:
// `generation` is a number and `scope` is an object (the two fields whose
// mistyping caused the empty-input-schema stringification bug).
const CANONICAL_GATE: Record<string, unknown> = {
  kind: 'gate-open',
  gateId: 'g_1022',
  generation: 1,
  scope: { kind: 'clarification-review', ref: 'generacy-ai/generacy#1022', phase: 'clarify' },
  openedAt: '2026-07-22T00:00:00.000Z',
};

describe('cockpit_gate_open parity (#1022)', () => {
  it('happy 200 → ok envelope with gateId + status', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gateId: 'g_1', status: 'open' }));
    const result = await cockpitGateOpen(CANONICAL_GATE, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.gateId).toBe('g_1');
    expect(result.data.status).toBe('open');
  });

  it('passthrough field forwarded (e.g. inboxUrl)', async () => {
    const spy = vi.fn(async () =>
      jsonResponse(200, { gateId: 'g_2', status: 'open', inboxUrl: 'https://app.example/inbox/g_2' }),
    );
    const result = await cockpitGateOpen(CANONICAL_GATE, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data['inboxUrl']).toBe('https://app.example/inbox/g_2');
  });

  it('input not an object → class: invalid-args', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gateId: 'g', status: 'open' }));
    const result = await cockpitGateOpen('not-an-object' as unknown, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });

  it('HTTP 400 → class: invalid-args', async () => {
    const spy = vi.fn(async () => jsonResponse(400, undefined, 'bad shape'));
    const result = await cockpitGateOpen(CANONICAL_GATE, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('HTTP 404 → class: unknown-gate', async () => {
    const spy = vi.fn(async () => jsonResponse(404, undefined, 'gate not found'));
    const result = await cockpitGateOpen(CANONICAL_GATE, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('unknown-gate');
  });

  it('HTTP 409 → class: invalid-args', async () => {
    const spy = vi.fn(async () => jsonResponse(409, undefined, 'conflict'));
    const result = await cockpitGateOpen(CANONICAL_GATE, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('HTTP 401 → class: internal', async () => {
    const spy = vi.fn(async () => jsonResponse(401, undefined, 'unauth'));
    const result = await cockpitGateOpen(CANONICAL_GATE, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
  });

  it('HTTP 500 → class: transport', async () => {
    const spy = vi.fn(async () => jsonResponse(500, undefined, 'boom'));
    const result = await cockpitGateOpen(CANONICAL_GATE, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('transport');
  });

  it('network error (fetchImpl throws) → class: transport', async () => {
    const spy = vi.fn(async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:3100');
    });
    const result = await cockpitGateOpen(CANONICAL_GATE, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('transport');
  });

  it('timeout (AbortController fires) → class: transport, detail mentions timeout', async () => {
    const spy = vi.fn(async (_url: string, opts?: RequestInit) => {
      await new Promise<never>((_, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
      throw new Error('unreachable');
    });
    const result = await cockpitGateOpen(CANONICAL_GATE, {
      orchestratorUrl: 'http://mock.local',
      orchestratorTimeoutMs: 10,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('transport');
    expect(result.detail).toMatch(/timed out after 10ms/);
  });

  it('2xx with missing gateId → class: internal', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { status: 'open' /* no gateId */ }));
    const result = await cockpitGateOpen(CANONICAL_GATE, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
    expect(result.detail).toBe('orchestrator returned malformed gate-open response');
  });
});

describe('cockpit_gate_open input schema — empty-schema/stringification regression', () => {
  // Root cause of the invalid-args bug: GateRecordSchema was a
  // `z.record().and(z.object({}).passthrough())` intersection. A ZodIntersection
  // has no `.shape`, so the MCP SDK advertised an EMPTY input schema and the
  // tool-call boundary stringified the typed `generation` (number) and `scope`
  // (object) fields; the orchestrator then rejected them as invalid-args.
  it('is a flat object schema exposing a .shape with generation + scope', () => {
    const shape = (
      CockpitGateOpenInputSchema as unknown as { shape?: Record<string, unknown> }
    ).shape;
    expect(shape, 'gate-open input schema must be a flat z.object with a .shape').toBeDefined();
    expect(Object.keys(shape ?? {})).toEqual(
      expect.arrayContaining(['gateId', 'generation', 'scope', 'openedAt']),
    );
  });

  it('accepts a valid envelope, preserving generation:number and scope:object', () => {
    const parsed = CockpitGateOpenInputSchema.safeParse({
      kind: 'gate-open',
      gateId: 'g_1',
      generation: 2,
      scope: { ref: 'o/r#1' },
      openedAt: '2026-07-22T00:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const data = parsed.data as Record<string, unknown>;
    expect(typeof data.generation).toBe('number');
    expect(typeof data.scope).toBe('object');
  });

  it('rejects a stringified generation (the mistyping the bug produced)', () => {
    const parsed = CockpitGateOpenInputSchema.safeParse({
      kind: 'gate-open',
      gateId: 'g_1',
      generation: '2',
      scope: { ref: 'o/r#1' },
      openedAt: '2026-07-22T00:00:00.000Z',
    });
    expect(parsed.success).toBe(false);
  });
});
