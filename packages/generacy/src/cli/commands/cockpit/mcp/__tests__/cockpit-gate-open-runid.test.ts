/**
 * #1053 — `runId` handling on `cockpit_gate_open` / `cockpit_gate_ack`.
 *
 * Four scenarios (see spec.md §User Stories US1/US2 and tasks.md T009):
 *   1. Explicit `runId` → `gateKey` suffix + distinct `gateId` vs the no-runId
 *      derivation of the same (issueRef, gateType, generation) triple.
 *   2. Fallback path when `runId` is omitted → tool mints `INSTANCE_NONCE`,
 *      logs the source via `getLogger().info({ event: '…runid-source', … })`,
 *      and the resulting `gateKey` suffix matches the process nonce. `runId`
 *      itself is NEVER logged (data-model E-3 privacy note).
 *   3. `askedAt` hoist — two calls with the SAME `runId` + input produce
 *      byte-identical `askedAt` values (US2 without cloud dedup).
 *   4. `cockpit_gate_ack` accepts `runId` on input (schema `.strict()` compat)
 *      and the outbound `gate-outcome` body is unchanged from the no-runId
 *      call — the ack path targets an existing `gateId`; no derivation.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { getLogger } from '../../../../utils/logger.js';
import { INSTANCE_NONCE } from '../event-bus.js';
import { cockpitGateAck } from '../tools/cockpit_gate_ack.js';
import { cockpitGateOpen } from '../tools/cockpit_gate_open.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function gateIdFor(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 24);
}

function bodyOfNth(spy: ReturnType<typeof vi.fn>, n: number): Record<string, unknown> {
  const init = spy.mock.calls[n]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

const BASE_DEPS = {
  orchestratorUrl: 'http://mock.local',
  orchestratorTimeoutMs: 5000,
};

const ISSUE_REF = 'christrudelpw/snappoll#1';
const GATE_TYPE = 'phase-queue';
const GENERATION = 'P2';

function baseOpenInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issueRef: ISSUE_REF,
    gateType: GATE_TYPE,
    generation: GENERATION,
    epicRef: ISSUE_REF,
    issueTitle: 'phase-queue P2',
    issueUrl: 'https://github.com/christrudelpw/snappoll/issues/1',
    title: 'Enter phase P2?',
    body: 'The queue is ready.',
    options: [],
    allowFreeText: true,
    sessionId: 'sess-1053-runid',
    askedAt: '2026-07-27T20:04:58.000Z',
    ...overrides,
  };
}

describe('cockpit_gate_open — runId handling (#1053)', () => {
  it('scenario 1: explicit runId is appended to gateKey and produces a distinct gateId', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { accepted: true, retained: false }));
    const runId = 'christrudelpw-snappoll-1-20260727-200458';
    const result = await cockpitGateOpen(baseOpenInput({ runId }), {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const expectedKey = `${ISSUE_REF}:${GATE_TYPE}:${GENERATION}:${runId}`;
    const expectedId = gateIdFor(expectedKey);
    const body = bodyOfNth(spy, 0);
    expect(body.gateKey).toBe(expectedKey);
    expect(String(body.gateKey).endsWith(`:${runId}`)).toBe(true);
    expect(body.gateId).toBe(expectedId);

    // Distinct from the no-runId derivation of the same triple (US1).
    expect(expectedId).not.toBe(gateIdFor(`${ISSUE_REF}:${GATE_TYPE}:${GENERATION}`));
  });

  it('scenario 2: no runId → fallback to INSTANCE_NONCE, logged at info, runId not in log', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { accepted: true, retained: false }));
    const logger = getLogger();
    const infoSpy = vi.spyOn(logger, 'info');

    try {
      // Use a distinct generation so this call is not confused with earlier
      // cache slots in the module-scoped askedAtCache.
      const result = await cockpitGateOpen(
        baseOpenInput({ generation: 'P2-scenario2' }),
        { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
      );
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;

      // (b) resulting gateKey ends in `:${INSTANCE_NONCE}`.
      const body = bodyOfNth(spy, 0);
      expect(String(body.gateKey).endsWith(`:${INSTANCE_NONCE}`)).toBe(true);

      // (a) the source-info log line fired.
      const runIdSourceCall = infoSpy.mock.calls.find((args) => {
        const meta = args[0] as { event?: string } | undefined;
        return meta?.event === 'cockpit_gate_open.runid-source';
      });
      expect(runIdSourceCall).toBeDefined();
      if (!runIdSourceCall) return;
      const meta = runIdSourceCall[0] as {
        event: string;
        runIdSource: string;
        gateId: string;
        gateType: string;
        issueRef: string;
      };
      expect(meta.runIdSource).toBe('fallback-instance-nonce');
      expect(meta.gateType).toBe(GATE_TYPE);
      expect(meta.issueRef).toBe(ISSUE_REF);

      // (c) runId itself is NOT in the log metadata (data-model E-3 privacy).
      expect(Object.keys(meta)).not.toContain('runId');
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('scenario 3: two calls with the same runId + input produce byte-identical askedAt', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { accepted: true, retained: false }));
    const runId = 'run-scenario3-1053';
    // askedAt intentionally omitted so the tool mints via `getOrMintAskedAt`.
    const inputA = baseOpenInput({ runId, generation: 'P3', askedAt: undefined });
    // Remove the undefined key so `.strict()` does not reject it.
    delete inputA.askedAt;
    const inputB = { ...inputA };

    await cockpitGateOpen(inputA, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });
    await cockpitGateOpen(inputB, {
      ...BASE_DEPS,
      fetchImpl: spy as unknown as typeof fetch,
    });

    const firstAskedAt = bodyOfNth(spy, 0).askedAt;
    const secondAskedAt = bodyOfNth(spy, 1).askedAt;
    expect(firstAskedAt).toBe(secondAskedAt);
    // And the whole wire body is identical (US2 correctness without cloud dedup).
    expect(bodyOfNth(spy, 0)).toEqual(bodyOfNth(spy, 1));
  });
});

describe('cockpit_gate_ack — runId passthrough (#1053)', () => {
  const GATE_ID = gateIdFor(`${ISSUE_REF}:${GATE_TYPE}:${GENERATION}:run-scenario4-1053`);
  const CANONICAL_ACK = {
    gateId: GATE_ID,
    outcome: 'applied' as const,
    at: '2026-07-27T20:05:10.000Z',
  };

  it('scenario 4: ack accepts runId on input and emits an unchanged gate-outcome body', async () => {
    const spyA = vi.fn(async () => jsonResponse(200, { ok: true }));
    const spyB = vi.fn(async () => jsonResponse(200, { ok: true }));

    const noRunId = await cockpitGateAck(CANONICAL_ACK, {
      ...BASE_DEPS,
      fetchImpl: spyA as unknown as typeof fetch,
    });
    expect(noRunId.status).toBe('ok');

    const withRunId = await cockpitGateAck(
      { ...CANONICAL_ACK, runId: 'run-scenario4-1053' },
      { ...BASE_DEPS, fetchImpl: spyB as unknown as typeof fetch },
    );
    // (a) the schema accepts runId — no invalid-args.
    expect(withRunId.status).toBe('ok');

    // (b) the outbound gate-outcome body is unchanged from the no-runId call.
    expect(bodyOfNth(spyA, 0)).toEqual(bodyOfNth(spyB, 0));
    const outboundBody = bodyOfNth(spyB, 0);
    expect(outboundBody).not.toHaveProperty('runId');
  });
});
