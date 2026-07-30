/**
 * #1067 — Three-tool tuple-identity matrix (FR-006 / SC-005).
 *
 * The read-side write-side loop MUST produce IDENTICAL gate identity across:
 *
 *   1. `cockpit_gate_open` — derives `gateKey` / `gateId` from
 *      (issueRef, gateType, generation, runId?).
 *   2. `cockpit_gate_status` — carries the same 4-tuple on the outbound URL
 *      to the cloud, which re-derives the same `gateKey` / `gateId`.
 *   3. `cockpit_gate_list` — the cloud returns entries keyed by the same
 *      derivation.
 *
 * If any two disagree, the cluster POSTs a gate under one identity and reads
 * back a different identity — the exact #1053 root cause the read-side widen
 * closes.
 *
 * Matrix (at minimum):
 *   - 3-tuple case (no `runId`)
 *   - 4-tuple case (explicit `runId`)
 *   - Distinct `runId` values ('A' vs 'B') → different `gateId`s
 *   - Empty-`generation` boundary
 *
 * Fake cloud: in-memory Map<gateKeyPreImage, gateId>. Follows the pattern
 * from `mcp/__tests__/*.integration.test.ts` families.
 */
import { describe, expect, it, vi } from 'vitest';
import { cockpitGateOpen } from '../tools/cockpit_gate_open.js';
import { cockpitGateStatus } from '../tools/cockpit_gate_status.js';
import { cockpitGateList } from '../tools/cockpit_gate_list.js';
import { deriveGateId, deriveGateKey, type GateType } from '../gates/schemas.js';

const BASE_DEPS = {
  orchestratorUrl: 'http://mock.local',
  orchestratorTimeoutMs: 5000,
};

const ISSUE_REF = 'generacy-ai/generacy#1067';
const GATE_TYPE: GateType = 'implementation-review';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Build a fake cloud state store keyed by 4-tuple pre-image. Deliberately
 * NOT keyed by the cloud's actual gateKey — we key by pre-image so we can
 * assert that different `runId`s produce different persisted rows.
 */
function makeFakeCloud() {
  const store = new Map<string, { gateId: string; gateType: GateType; generation: string; runId?: string; issueRef: string }>();
  function preImage(issueRef: string, gateType: string, generation: string, runId?: string): string {
    return runId === undefined
      ? `${issueRef}::${gateType}::${generation}`
      : `${issueRef}::${gateType}::${generation}::${runId}`;
  }
  return {
    store,
    preImage,
    /** Simulate cloud's gateKey/gateId derivation for the given tuple. */
    deriveGateId(issueRef: string, gateType: GateType, generation: string, runId?: string): string {
      return deriveGateId(deriveGateKey(issueRef, gateType, generation, runId));
    },
  };
}

function baseOpenInput(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    issueRef: ISSUE_REF,
    gateType: GATE_TYPE,
    generation: 'gen-1',
    epicRef: ISSUE_REF,
    issueTitle: 'test issue',
    issueUrl: 'https://github.com/generacy-ai/generacy/issues/1067',
    title: 'test title',
    body: 'test body',
    options: [],
    allowFreeText: true,
    sessionId: 'sess-tuple-identity',
    askedAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Fake fetchImpl for the write path: intercepts POST /cockpit/gates from
 * cockpit_gate_open and records the derived gateKey/gateId into the fake
 * cloud store. Returns 200 { accepted, retained: false } to satisfy the
 * response envelope.
 */
function makeWriteFetch(
  cloud: ReturnType<typeof makeFakeCloud>,
): {
  fetchImpl: typeof fetch;
  postedBodies: Array<Record<string, unknown>>;
} {
  const postedBodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    postedBodies.push(body);
    // Persist by 4-tuple pre-image, using the gateKey derivation the tool
    // used. gateKey format: `${issueRef}:${gateType}:${generation}[:${runId}]`
    const key = String(body.gateKey);
    const segments = key.split(':');
    // Handle multi-colon issueRefs (owner/repo#N contains no colons, but be defensive).
    // The write path always sets exactly 3 or 4 segments per deriveGateKey.
    const runId = segments.length === 4 ? segments[3] : undefined;
    cloud.store.set(
      cloud.preImage(String(body.issueRef), String(body.gateType), String(segments[2]), runId),
      {
        gateId: String(body.gateId),
        gateType: body.gateType as GateType,
        generation: String(segments[2]),
        ...(runId !== undefined ? { runId } : {}),
        issueRef: String(body.issueRef),
      },
    );
    void url;
    return jsonResponse(200, { accepted: true, retained: false });
  }) as unknown as typeof fetch;
  return { fetchImpl, postedBodies };
}

/**
 * Fake fetchImpl for the status read path: intercepts GET /cockpit/gates and
 * mimics the cloud's 4-tuple key lookup — the read path passes runId as a
 * query-string param, which we extract and re-derive against the store.
 */
function makeStatusFetch(cloud: ReturnType<typeof makeFakeCloud>): typeof fetch {
  return (async (url: string | URL) => {
    const u = new URL(String(url));
    const issueRef = u.searchParams.get('issueRef')!;
    const gateType = u.searchParams.get('gateType')! as GateType;
    const generation = u.searchParams.get('generation')!;
    const runId = u.searchParams.get('runId') ?? undefined;
    const key = cloud.preImage(issueRef, gateType, generation, runId);
    const found = cloud.store.get(key);
    if (found) {
      return jsonResponse(200, { gateId: found.gateId, status: 'open' });
    }
    return jsonResponse(200, { gateId: null, status: 'absent' });
  }) as unknown as typeof fetch;
}

/**
 * Fake fetchImpl for the list read path: returns every entry from the fake
 * cloud store matching the issueRef (and gateType if supplied). Since the
 * read side deliberately DROPS `runId` on list mode (see cockpit_gate_list.ts),
 * the fake cloud returns every 4-tuple row for the (issueRef, gateType).
 */
function makeListFetch(cloud: ReturnType<typeof makeFakeCloud>): typeof fetch {
  return (async (url: string | URL) => {
    const u = new URL(String(url));
    const issueRef = u.searchParams.get('issueRef')!;
    const gateType = u.searchParams.get('gateType') ?? undefined;
    const gates: Array<{
      gateId: string;
      gateType: GateType;
      generation: string;
      status: 'open';
    }> = [];
    for (const [, entry] of cloud.store) {
      if (entry.issueRef !== issueRef) continue;
      if (gateType !== undefined && entry.gateType !== gateType) continue;
      gates.push({
        gateId: entry.gateId,
        gateType: entry.gateType,
        generation: entry.generation,
        status: 'open',
      });
    }
    return jsonResponse(200, { gates });
  }) as unknown as typeof fetch;
}

describe('#1067 three-tool tuple-identity matrix (FR-006 / SC-005)', () => {
  it('3-tuple case (no runId) — open/status/list derive the same gateKey / gateId', async () => {
    const cloud = makeFakeCloud();
    const generation = 'gen-3tuple';
    const expectedKey = deriveGateKey(ISSUE_REF, GATE_TYPE, generation);
    const expectedId = deriveGateId(expectedKey);

    // 1) open: writes into the fake cloud.
    const { fetchImpl: openFetch, postedBodies } = makeWriteFetch(cloud);
    const openResult = await cockpitGateOpen(baseOpenInput({ generation }), {
      ...BASE_DEPS,
      fetchImpl: openFetch,
    });
    expect(openResult.status).toBe('ok');
    expect(postedBodies[0]?.gateKey).toBe(expectedKey);
    expect(postedBodies[0]?.gateId).toBe(expectedId);

    // 2) status: reads back the same gateId.
    const statusResult = await cockpitGateStatus(
      { issueRef: ISSUE_REF, gateType: GATE_TYPE, generation },
      { ...BASE_DEPS, fetchImpl: makeStatusFetch(cloud) },
    );
    expect(statusResult.status).toBe('ok');
    if (statusResult.status !== 'ok') return;
    expect(statusResult.data.status).toBe('open');
    expect(statusResult.data.gateId).toBe(expectedId);

    // 3) list: entry gateId matches.
    const listResult = await cockpitGateList(
      { issueRef: ISSUE_REF, gateType: GATE_TYPE },
      { ...BASE_DEPS, fetchImpl: makeListFetch(cloud) },
    );
    expect(listResult.status).toBe('ok');
    if (listResult.status !== 'ok') return;
    const entry = listResult.data.gates.find((g) => g.gateId === expectedId);
    expect(entry).toBeDefined();
    expect(entry?.generation).toBe(generation);
  });

  it('4-tuple case (explicit runId) — open/status/list derive the same 4-tuple gateKey / gateId', async () => {
    const cloud = makeFakeCloud();
    const generation = 'gen-4tuple';
    const runId = 'auto-cluster-1067-A';
    const expectedKey = deriveGateKey(ISSUE_REF, GATE_TYPE, generation, runId);
    const expectedId = deriveGateId(expectedKey);

    const { fetchImpl: openFetch, postedBodies } = makeWriteFetch(cloud);
    await cockpitGateOpen(baseOpenInput({ generation, runId }), {
      ...BASE_DEPS,
      fetchImpl: openFetch,
    });
    expect(postedBodies[0]?.gateKey).toBe(expectedKey);
    expect(postedBodies[0]?.gateId).toBe(expectedId);
    expect(String(postedBodies[0]?.gateKey).endsWith(`:${runId}`)).toBe(true);

    const statusResult = await cockpitGateStatus(
      { issueRef: ISSUE_REF, gateType: GATE_TYPE, generation, runId },
      { ...BASE_DEPS, fetchImpl: makeStatusFetch(cloud) },
    );
    expect(statusResult.status).toBe('ok');
    if (statusResult.status !== 'ok') return;
    expect(statusResult.data.status).toBe('open');
    expect(statusResult.data.gateId).toBe(expectedId);

    const listResult = await cockpitGateList(
      { issueRef: ISSUE_REF, gateType: GATE_TYPE },
      { ...BASE_DEPS, fetchImpl: makeListFetch(cloud) },
    );
    expect(listResult.status).toBe('ok');
    if (listResult.status !== 'ok') return;
    const entry = listResult.data.gates.find((g) => g.gateId === expectedId);
    expect(entry).toBeDefined();
  });

  it('distinct runId values (A vs B) → different gateIds', async () => {
    const cloud = makeFakeCloud();
    const generation = 'gen-distinct-runid';
    const runIdA = 'auto-cluster-1067-A';
    const runIdB = 'auto-cluster-1067-B';
    const idA = deriveGateId(deriveGateKey(ISSUE_REF, GATE_TYPE, generation, runIdA));
    const idB = deriveGateId(deriveGateKey(ISSUE_REF, GATE_TYPE, generation, runIdB));

    // Distinct pre-images ⇒ distinct hashed gate ids.
    expect(idA).not.toBe(idB);

    const { fetchImpl: openFetch } = makeWriteFetch(cloud);
    await cockpitGateOpen(baseOpenInput({ generation, runId: runIdA }), {
      ...BASE_DEPS,
      fetchImpl: openFetch,
    });
    await cockpitGateOpen(baseOpenInput({ generation, runId: runIdB }), {
      ...BASE_DEPS,
      fetchImpl: openFetch,
    });

    // Status with runId A returns id A; status with runId B returns id B.
    const statusA = await cockpitGateStatus(
      { issueRef: ISSUE_REF, gateType: GATE_TYPE, generation, runId: runIdA },
      { ...BASE_DEPS, fetchImpl: makeStatusFetch(cloud) },
    );
    const statusB = await cockpitGateStatus(
      { issueRef: ISSUE_REF, gateType: GATE_TYPE, generation, runId: runIdB },
      { ...BASE_DEPS, fetchImpl: makeStatusFetch(cloud) },
    );
    expect(statusA.status).toBe('ok');
    expect(statusB.status).toBe('ok');
    if (statusA.status !== 'ok' || statusB.status !== 'ok') return;
    expect(statusA.data.gateId).toBe(idA);
    expect(statusB.data.gateId).toBe(idB);

    // List returns two distinct rows for the same (issueRef, gateType, generation),
    // one per runId — proving the fake cloud stored them separately.
    const listResult = await cockpitGateList(
      { issueRef: ISSUE_REF, gateType: GATE_TYPE },
      { ...BASE_DEPS, fetchImpl: makeListFetch(cloud) },
    );
    expect(listResult.status).toBe('ok');
    if (listResult.status !== 'ok') return;
    const ids = listResult.data.gates.map((g) => g.gateId).sort();
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);
    // Load-bearing: distinct persisted rows for distinct runIds — US3.
    expect(new Set(ids).size).toBeGreaterThanOrEqual(2);
  });

  it('runId "A" vs no-runId — read paths do not confuse each other (list returns both rows)', async () => {
    const cloud = makeFakeCloud();
    const generation = 'gen-mixed';
    const runIdA = 'auto-cluster-1067-A';
    const id3Tuple = deriveGateId(deriveGateKey(ISSUE_REF, GATE_TYPE, generation));
    const id4Tuple = deriveGateId(deriveGateKey(ISSUE_REF, GATE_TYPE, generation, runIdA));
    expect(id3Tuple).not.toBe(id4Tuple);

    // Open one with no runId and one with runId A — two distinct persisted rows.
    const { fetchImpl: openFetch } = makeWriteFetch(cloud);
    await cockpitGateOpen(baseOpenInput({ generation }), {
      ...BASE_DEPS,
      fetchImpl: openFetch,
    });
    await cockpitGateOpen(baseOpenInput({ generation, runId: runIdA }), {
      ...BASE_DEPS,
      fetchImpl: openFetch,
    });

    // Status with runId A returns 4-tuple id; status without runId returns 3-tuple id.
    const withRunId = await cockpitGateStatus(
      { issueRef: ISSUE_REF, gateType: GATE_TYPE, generation, runId: runIdA },
      { ...BASE_DEPS, fetchImpl: makeStatusFetch(cloud) },
    );
    const withoutRunId = await cockpitGateStatus(
      { issueRef: ISSUE_REF, gateType: GATE_TYPE, generation },
      { ...BASE_DEPS, fetchImpl: makeStatusFetch(cloud) },
    );
    if (withRunId.status !== 'ok' || withoutRunId.status !== 'ok') {
      throw new Error('gate-status calls failed unexpectedly');
    }
    expect(withRunId.data.gateId).toBe(id4Tuple);
    expect(withoutRunId.data.gateId).toBe(id3Tuple);
  });

  it('empty-generation boundary — deriveGateKey still produces a well-formed 3/4-tuple', () => {
    // `generation` is Zod-guarded to min-length 1 at the MCP input layer; this
    // test asserts the derivation itself does not choke when a caller reaches
    // deriveGateKey with an empty string (e.g. accidental fall-through). The
    // point is to verify SC-005 does not silently collide the empty case
    // with any nearby tuple.
    const emptyGen3 = deriveGateKey(ISSUE_REF, GATE_TYPE, '');
    expect(emptyGen3).toBe(`${ISSUE_REF}:${GATE_TYPE}:`);
    const emptyGen4 = deriveGateKey(ISSUE_REF, GATE_TYPE, '', 'run-X');
    expect(emptyGen4).toBe(`${ISSUE_REF}:${GATE_TYPE}::run-X`);
    // The two hash to distinct ids — the trailing runId segment discriminates
    // even in the empty-generation edge case.
    expect(deriveGateId(emptyGen3)).not.toBe(deriveGateId(emptyGen4));
  });
});

// Silence unused warning when vi is not exercised (kept for symmetry with siblings).
void vi;
