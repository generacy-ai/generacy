/**
 * #1067 SC-004 — end-to-end write→read integration with fake cloud (research R6).
 *
 * Fake cloud persists gates keyed by the 4-tuple pre-image
 * `(issueRef, gateType, generation, runId?)`. Sequence:
 *
 *   1. cockpit_gate_open({triple, runId:'A'}) → cloud stores 4-tuple.
 *   2. cockpit_gate_status({triple, runId:'A'}) → returns 'open' (not 'absent').
 *   3. cockpit_gate_open({triple, runId:'B'}) → cloud stores DIFFERENT 4-tuple.
 *   4. cockpit_gate_status({triple, runId:'A'}) → still 'open' (isolated by runId).
 *   5. cockpit_gate_status({triple, runId:'B'}) → 'open' (fresh gate — US3).
 *   6. cockpit_gate_status({triple}) [no runId] → does not throw; returns a
 *      defined ThreeState (byte-compat; legacy path behaviour is cloud-owned).
 */
import { describe, expect, it } from 'vitest';
import { cockpitGateOpen } from '../tools/cockpit_gate_open.js';
import { cockpitGateStatus } from '../tools/cockpit_gate_status.js';
import { deriveGateId, deriveGateKey, type GateType } from '../gates/schemas.js';

const BASE_DEPS = {
  orchestratorUrl: 'http://mock.local',
  orchestratorTimeoutMs: 5000,
};

const ISSUE_REF = 'generacy-ai/generacy#1067';
const GATE_TYPE: GateType = 'implementation-review';
const GENERATION = 'abc123';
const RUN_ID_A = 'auto-cluster-1067-A';
const RUN_ID_B = 'auto-cluster-1067-B';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Fake cloud keyed by 4-tuple pre-image. `preImage` deliberately keys on
 * runId presence — this is the load-bearing US3 assertion (different runIds
 * produce different persisted rows).
 */
function makeFakeCloud() {
  const store = new Map<string, { gateId: string; runId?: string }>();
  const preImage = (
    issueRef: string,
    gateType: string,
    generation: string,
    runId?: string,
  ): string =>
    runId === undefined
      ? `${issueRef}::${gateType}::${generation}`
      : `${issueRef}::${gateType}::${generation}::${runId}`;
  return { store, preImage };
}

function makeSharedFetch(cloud: ReturnType<typeof makeFakeCloud>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const key = String(body.gateKey);
      const segments = key.split(':');
      const runId = segments.length === 4 ? segments[3] : undefined;
      cloud.store.set(
        cloud.preImage(String(body.issueRef), String(body.gateType), String(segments[2]), runId),
        {
          gateId: String(body.gateId),
          ...(runId !== undefined ? { runId } : {}),
        },
      );
      return jsonResponse(200, { accepted: true, retained: false });
    }
    // GET path — cockpit_gate_status.
    const u = new URL(String(url));
    const issueRef = u.searchParams.get('issueRef')!;
    const gateType = u.searchParams.get('gateType')!;
    const generation = u.searchParams.get('generation')!;
    const runId = u.searchParams.get('runId') ?? undefined;
    const found = cloud.store.get(cloud.preImage(issueRef, gateType, generation, runId));
    if (found) return jsonResponse(200, { gateId: found.gateId, status: 'open' });
    return jsonResponse(200, { gateId: null, status: 'absent' });
  }) as unknown as typeof fetch;
}

function baseOpenInput(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    issueRef: ISSUE_REF,
    gateType: GATE_TYPE,
    generation: GENERATION,
    epicRef: ISSUE_REF,
    issueTitle: 'test',
    issueUrl: 'https://github.com/generacy-ai/generacy/issues/1067',
    title: 'Title',
    body: 'Body',
    options: [],
    allowFreeText: true,
    sessionId: 'sess-1067-integration',
    askedAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('#1067 SC-004 — open → status round-trip with runId isolation', () => {
  it('sequence 1..6 — write-4/read-4 preserves gate identity across runIds', async () => {
    const cloud = makeFakeCloud();
    const fetchImpl = makeSharedFetch(cloud);

    // Expected 4-tuple gate identities.
    const idA = deriveGateId(deriveGateKey(ISSUE_REF, GATE_TYPE, GENERATION, RUN_ID_A));
    const idB = deriveGateId(deriveGateKey(ISSUE_REF, GATE_TYPE, GENERATION, RUN_ID_B));
    const id3 = deriveGateId(deriveGateKey(ISSUE_REF, GATE_TYPE, GENERATION));
    expect(idA).not.toBe(idB);
    expect(idA).not.toBe(id3);
    expect(idB).not.toBe(id3);

    // 1. Open with runId:'A' → cloud stores 4-tuple.
    const openA = await cockpitGateOpen(baseOpenInput({ runId: RUN_ID_A }), {
      ...BASE_DEPS,
      fetchImpl,
    });
    expect(openA.status).toBe('ok');

    // 2. Status with runId:'A' → returns 'open' (not 'absent').
    const statusA1 = await cockpitGateStatus(
      { issueRef: ISSUE_REF, gateType: GATE_TYPE, generation: GENERATION, runId: RUN_ID_A },
      { ...BASE_DEPS, fetchImpl },
    );
    expect(statusA1.status).toBe('ok');
    if (statusA1.status !== 'ok') return;
    expect(statusA1.data.status).toBe('open');
    expect(statusA1.data.gateId).toBe(idA);

    // 3. Open with runId:'B' → cloud stores a DIFFERENT 4-tuple.
    const openB = await cockpitGateOpen(baseOpenInput({ runId: RUN_ID_B }), {
      ...BASE_DEPS,
      fetchImpl,
    });
    expect(openB.status).toBe('ok');
    // Fake cloud persisted two distinct rows (SC-004 core assertion).
    expect(cloud.store.size).toBe(2);

    // 4. Status with runId:'A' → still 'open' (isolated by runId).
    const statusA2 = await cockpitGateStatus(
      { issueRef: ISSUE_REF, gateType: GATE_TYPE, generation: GENERATION, runId: RUN_ID_A },
      { ...BASE_DEPS, fetchImpl },
    );
    if (statusA2.status !== 'ok') return;
    expect(statusA2.data.status).toBe('open');
    expect(statusA2.data.gateId).toBe(idA);

    // 5. Status with runId:'B' → 'open' (fresh gate — US3).
    const statusB = await cockpitGateStatus(
      { issueRef: ISSUE_REF, gateType: GATE_TYPE, generation: GENERATION, runId: RUN_ID_B },
      { ...BASE_DEPS, fetchImpl },
    );
    if (statusB.status !== 'ok') return;
    expect(statusB.data.status).toBe('open');
    expect(statusB.data.gateId).toBe(idB);

    // 6. Status without runId → does not throw, returns a defined ThreeState.
    //    Byte-compat only — legacy path behaviour is cloud-owned.
    const statusLegacy = await cockpitGateStatus(
      { issueRef: ISSUE_REF, gateType: GATE_TYPE, generation: GENERATION },
      { ...BASE_DEPS, fetchImpl },
    );
    expect(statusLegacy.status).toBe('ok');
    if (statusLegacy.status !== 'ok') return;
    // The fake cloud has no 3-tuple entry — it returns absent for this shape.
    // The assertion is: the call succeeded and returned a well-formed
    // ThreeState envelope (not that any specific status came back).
    expect(['open', 'answered', 'absent']).toContain(statusLegacy.data.status);
  });
});
