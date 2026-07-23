/**
 * Parity tests for `cockpit_gate_open` (#1022 / #843) — the FROZEN wire contract.
 *
 * The tool now takes SEMANTIC fields and DERIVES gateKey + gateId, assembling
 * the flat frozen gate-open record (type:'gate-open', presentation fields at top
 * level) that the orchestrator relays verbatim to the cloud. These tests pin
 * that frozen shape and the derivation — they REPLACE the prior #1033/#1035 pins
 * that asserted the WRONG { kind, scope, generation, openedAt } shape.
 *
 * Injection pattern mirrors parity-claim.test.ts: build the tool with a spy
 * `fetchImpl` so no real HTTP call is made and no `global.fetch` monkey-patch
 * is needed.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { cockpitGateOpen } from '../tools/cockpit_gate_open.js';

function jsonResponse(status: number, body: unknown, text?: string): Response {
  return new Response(text ?? (body === undefined ? '' : JSON.stringify(body)), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function gateIdFor(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 24);
}

function bodyOf(spy: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = spy.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

const BASE_DEPS = {
  orchestratorUrl: 'http://mock.local',
  orchestratorTimeoutMs: 5000,
};

const ISSUE_REF = 'generacy-ai/generacy#1022';
const GATE_TYPE = 'clarification';
const GENERATION = 'batch-7f3a2b';
const EXPECTED_KEY = `${ISSUE_REF}:${GATE_TYPE}:${GENERATION}`;
const EXPECTED_ID = gateIdFor(EXPECTED_KEY);

const CANONICAL_INPUT: Record<string, unknown> = {
  issueRef: ISSUE_REF,
  gateType: GATE_TYPE,
  generation: GENERATION,
  epicRef: 'generacy-ai/generacy#1000',
  issueTitle: 'Remote gates wire contract',
  issueUrl: 'https://github.com/generacy-ai/generacy/issues/1022',
  title: 'Answer the open clarifications',
  body: 'Two questions are outstanding.',
  options: [
    { id: 'approve', label: 'Approve drafted answers', recommended: true },
    { id: 'revise', label: 'Make changes' },
  ],
  allowFreeText: true,
  sessionId: 'sess-abcdef0123456789',
  askedAt: '2026-07-22T12:00:00.000Z',
};

describe('cockpit_gate_open parity — frozen contract (#1022/#843)', () => {
  it('derives gateKey + gateId and forwards the flat frozen record', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { accepted: true, retained: false }));
    const result = await cockpitGateOpen(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.gateId).toBe(EXPECTED_ID);
    expect(result.data.status).toBe('open');

    // POSTs to the gate-open route.
    expect(spy.mock.calls[0]?.[0]).toBe('http://mock.local/cockpit/gates');

    const body = bodyOf(spy);
    expect(body.type).toBe('gate-open');
    expect(body.gateKey).toBe(EXPECTED_KEY);
    expect(body.gateId).toBe(EXPECTED_ID);
    expect(String(body.gateId)).toHaveLength(24);
    expect(body.gateType).toBe('clarification');
    expect(body.issueRef).toBe(ISSUE_REF);
    expect(body.epicRef).toBe('generacy-ai/generacy#1000');
    expect(body.issueTitle).toBe(CANONICAL_INPUT.issueTitle);
    expect(body.issueUrl).toBe(CANONICAL_INPUT.issueUrl);
    expect(body.title).toBe(CANONICAL_INPUT.title);
    expect(body.body).toBe(CANONICAL_INPUT.body);
    expect(body.options).toEqual(CANONICAL_INPUT.options);
    expect(body.allowFreeText).toBe(true);
    expect(body.sessionId).toBe(CANONICAL_INPUT.sessionId);
    expect(body.askedAt).toBe('2026-07-22T12:00:00.000Z');

    // The old WRONG shape must NOT leak onto the wire.
    expect(body).not.toHaveProperty('kind');
    expect(body).not.toHaveProperty('scope');
    expect(body).not.toHaveProperty('generation');
    expect(body).not.toHaveProperty('openedAt');
  });

  it('coerces a numeric generation into gateKey (phase-queue on the epic ref)', async () => {
    const epicRef = 'generacy-ai/generacy#1000';
    const key = `${epicRef}:phase-queue:2`;
    const id = gateIdFor(key);
    const spy = vi.fn(async () => jsonResponse(200, { accepted: true, retained: false }));
    const result = await cockpitGateOpen(
      {
        ...CANONICAL_INPUT,
        issueRef: epicRef,
        gateType: 'phase-queue',
        generation: 2,
        options: [],
      },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('ok');
    const body = bodyOf(spy);
    expect(body.gateType).toBe('phase-queue');
    expect(body.gateKey).toBe(key);
    expect(body.gateId).toBe(id);
  });

  it('forwards branch + prNumber when supplied (implementation-review)', async () => {
    const key = `${ISSUE_REF}:implementation-review:deadbeefcafe`;
    const id = gateIdFor(key);
    const spy = vi.fn(async () => jsonResponse(200, { accepted: true, retained: false }));
    const result = await cockpitGateOpen(
      {
        ...CANONICAL_INPUT,
        gateType: 'implementation-review',
        generation: 'deadbeefcafe',
        branch: 'feat/1022-gates',
        prNumber: 42,
      },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('ok');
    const body = bodyOf(spy);
    expect(body.branch).toBe('feat/1022-gates');
    expect(body.prNumber).toBe(42);
  });

  it('omits optional wire fields (branch/prNumber) when absent', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { accepted: true, retained: false }));
    await cockpitGateOpen(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    const body = bodyOf(spy);
    expect(body).not.toHaveProperty('branch');
    expect(body).not.toHaveProperty('prNumber');
  });

  it('defaults askedAt to a fresh ISO timestamp when omitted', async () => {
    const { askedAt: _drop, ...noAskedAt } = CANONICAL_INPUT;
    const spy = vi.fn(async () => jsonResponse(200, { accepted: true, retained: false }));
    const result = await cockpitGateOpen(noAskedAt, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    const body = bodyOf(spy);
    expect(typeof body.askedAt).toBe('string');
    expect(() => new Date(body.askedAt as string).toISOString()).not.toThrow();
    expect(Number.isNaN(Date.parse(body.askedAt as string))).toBe(false);
  });

  it('defaults allowFreeText to true when omitted', async () => {
    const { allowFreeText: _drop, ...noFreeText } = CANONICAL_INPUT;
    const spy = vi.fn(async () => jsonResponse(200, { accepted: true, retained: false }));
    await cockpitGateOpen(noFreeText, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(bodyOf(spy).allowFreeText).toBe(true);
  });

  it('passthrough response field forwarded (e.g. inboxUrl)', async () => {
    const spy = vi.fn(async () =>
      jsonResponse(200, {
        accepted: true,
        retained: false,
        inboxUrl: 'https://app.example/inbox/g_2',
      }),
    );
    const result = await cockpitGateOpen(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data['inboxUrl']).toBe('https://app.example/inbox/g_2');
  });

  // Regression pins for the orchestrator response contract (#1036 follow-up):
  // the route is fire-and-forget and replies `{ accepted, retained }` — NOT a
  // `{ gateId, status }` echo. The tool maps that ack to `{ gateId (derived),
  // status }`. The old fictional `{ gateId, status }` mock hid this mismatch.
  it('maps the real orchestrator ack { accepted, retained:false } → status "open" + derived gateId', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { accepted: true, retained: false }));
    const result = await cockpitGateOpen(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.gateId).toBe(EXPECTED_ID);
    expect(result.data.status).toBe('open');
  });

  it('retained ack { accepted, retained:true } → status "retained" (relay down; queued)', async () => {
    const spy = vi.fn(async () =>
      jsonResponse(200, {
        accepted: true,
        retained: true,
        retainQueue: { count: 1, bytes: 512 },
      }),
    );
    const result = await cockpitGateOpen(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.gateId).toBe(EXPECTED_ID);
    expect(result.data.status).toBe('retained');
  });

  it('a response missing accepted/retained (e.g. the old { gateId, status } echo) → internal error', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { gateId: EXPECTED_ID, status: 'open' }));
    const result = await cockpitGateOpen(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
    expect(result.detail).toMatch(/malformed gate-open response/);
  });

  it('input not an object → class: invalid-args (no HTTP call)', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { accepted: true, retained: false }));
    const result = await cockpitGateOpen('not-an-object' as unknown, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });

  it('missing required field (sessionId) → class: invalid-args (no HTTP call)', async () => {
    const { sessionId: _drop, ...noSession } = CANONICAL_INPUT;
    const spy = vi.fn(async () => jsonResponse(200, { accepted: true, retained: false }));
    const result = await cockpitGateOpen(noSession, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });

  it('unknown gateType → class: invalid-args (no HTTP call)', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { accepted: true, retained: false }));
    const result = await cockpitGateOpen(
      { ...CANONICAL_INPUT, gateType: 'not-a-gate-type' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });

  it('extra/unknown key (strict) → class: invalid-args (no HTTP call)', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { accepted: true, retained: false }));
    const result = await cockpitGateOpen(
      { ...CANONICAL_INPUT, gateId: 'hand-built-should-be-rejected' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });

  it('non-URL issueUrl → class: invalid-args (no HTTP call)', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { accepted: true, retained: false }));
    const result = await cockpitGateOpen(
      { ...CANONICAL_INPUT, issueUrl: 'generacy-ai/generacy#1022' },
      { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
    expect(spy).not.toHaveBeenCalled();
  });

  it('HTTP 400 → class: invalid-args', async () => {
    const spy = vi.fn(async () => jsonResponse(400, undefined, 'bad shape'));
    const result = await cockpitGateOpen(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('HTTP 404 → class: unknown-gate', async () => {
    const spy = vi.fn(async () => jsonResponse(404, undefined, 'gate not found'));
    const result = await cockpitGateOpen(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('unknown-gate');
  });

  it('HTTP 409 → class: invalid-args', async () => {
    const spy = vi.fn(async () => jsonResponse(409, undefined, 'conflict'));
    const result = await cockpitGateOpen(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('HTTP 401 → class: internal', async () => {
    const spy = vi.fn(async () => jsonResponse(401, undefined, 'unauth'));
    const result = await cockpitGateOpen(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
  });

  it('HTTP 500 → class: transport', async () => {
    const spy = vi.fn(async () => jsonResponse(500, undefined, 'boom'));
    const result = await cockpitGateOpen(CANONICAL_INPUT, {
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
    const result = await cockpitGateOpen(CANONICAL_INPUT, {
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
    const result = await cockpitGateOpen(CANONICAL_INPUT, {
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
    const result = await cockpitGateOpen(CANONICAL_INPUT, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
    expect(result.detail).toBe('orchestrator returned malformed gate-open response');
  });
});
