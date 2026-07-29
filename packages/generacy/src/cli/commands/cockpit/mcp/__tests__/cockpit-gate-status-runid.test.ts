/**
 * #1067 FR-008 — `cockpit_gate_status.runid-source` log-line assertion.
 *
 * Data-model E5:
 *   {
 *     event: 'cockpit_gate_status.runid-source',
 *     runIdSource: 'explicit' | 'unset',
 *     mode: 'status',
 *     gateType, issueRef, resolvedStatus, gateId,
 *     error? (present iff resolvedStatus === 'error')
 *   }
 *
 * Invariants:
 *   - The runId VALUE is NEVER logged — only `runIdSource`.
 *   - `cockpit_gate_list` MUST NOT emit this record (Q3=C consequent of Q1=C).
 *   - Emitted on BOTH success AND failure paths (R4).
 */
import { describe, expect, it, vi } from 'vitest';
import { getLogger } from '../../../../utils/logger.js';
import { cockpitGateStatus } from '../tools/cockpit_gate_status.js';
import { cockpitGateList } from '../tools/cockpit_gate_list.js';

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

const GATE_ID = 'a'.repeat(24);
const ISSUE_REF = 'generacy-ai/generacy#1067';
const GATE_TYPE = 'implementation-review';
const GENERATION = 'abc123';
const RUN_ID = 'auto-cluster-1067-1722243247891';

interface RunIdSourceRecord {
  event: string;
  runIdSource: string;
  mode?: string;
  gateType?: string;
  issueRef?: string;
  resolvedStatus?: string;
  gateId?: string | null;
  error?: string;
  runId?: string;
}

function findRunIdSourceRecord(
  spy: ReturnType<typeof vi.spyOn>,
): RunIdSourceRecord | undefined {
  const calls = spy.mock.calls as unknown as Array<[Record<string, unknown>, string?]>;
  for (const args of calls) {
    const meta = args[0];
    if (meta && (meta as { event?: unknown }).event === 'cockpit_gate_status.runid-source') {
      return meta as unknown as RunIdSourceRecord;
    }
  }
  return undefined;
}

describe('#1067 FR-008 — cockpit_gate_status.runid-source log line', () => {
  it('success path with runId: emits record with runIdSource:"explicit", correct fields, no runId value', async () => {
    const logger = getLogger();
    const infoSpy = vi.spyOn(logger, 'info');
    try {
      const spy = vi.fn(async () =>
        jsonResponse(200, { gateId: GATE_ID, status: 'open' }),
      );
      const result = await cockpitGateStatus(
        {
          issueRef: ISSUE_REF,
          gateType: GATE_TYPE,
          generation: GENERATION,
          runId: RUN_ID,
        },
        { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
      );
      expect(result.status).toBe('ok');

      const rec = findRunIdSourceRecord(infoSpy);
      expect(rec, 'must emit cockpit_gate_status.runid-source').toBeDefined();
      if (!rec) return;
      expect(rec.runIdSource).toBe('explicit');
      expect(rec.mode).toBe('status');
      expect(rec.gateType).toBe(GATE_TYPE);
      expect(rec.issueRef).toBe(ISSUE_REF);
      expect(rec.resolvedStatus).toBe('open');
      expect(rec.gateId).toBe(GATE_ID);
      // Invariant (data-model E5): runId VALUE must not appear in the log.
      expect(Object.keys(rec)).not.toContain('runId');
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('success path without runId: emits record with runIdSource:"unset"', async () => {
    const logger = getLogger();
    const infoSpy = vi.spyOn(logger, 'info');
    try {
      const spy = vi.fn(async () =>
        jsonResponse(200, { gateId: GATE_ID, status: 'answered' }),
      );
      const result = await cockpitGateStatus(
        {
          issueRef: ISSUE_REF,
          gateType: GATE_TYPE,
          generation: GENERATION,
        },
        { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
      );
      expect(result.status).toBe('ok');

      const rec = findRunIdSourceRecord(infoSpy);
      expect(rec).toBeDefined();
      if (!rec) return;
      expect(rec.runIdSource).toBe('unset');
      expect(rec.mode).toBe('status');
      expect(rec.resolvedStatus).toBe('answered');
      expect(rec.gateId).toBe(GATE_ID);
      expect(Object.keys(rec)).not.toContain('runId');
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('success absent: emits record with resolvedStatus:"absent" and gateId:null', async () => {
    const logger = getLogger();
    const infoSpy = vi.spyOn(logger, 'info');
    try {
      const spy = vi.fn(async () =>
        jsonResponse(200, { gateId: null, status: 'absent' }),
      );
      const result = await cockpitGateStatus(
        {
          issueRef: ISSUE_REF,
          gateType: GATE_TYPE,
          generation: GENERATION,
        },
        { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
      );
      expect(result.status).toBe('ok');

      const rec = findRunIdSourceRecord(infoSpy);
      expect(rec).toBeDefined();
      if (!rec) return;
      expect(rec.resolvedStatus).toBe('absent');
      expect(rec.gateId).toBeNull();
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('failure path (transport error): emits record with resolvedStatus:"error", gateId:null, and error field', async () => {
    const logger = getLogger();
    const infoSpy = vi.spyOn(logger, 'info');
    try {
      // Retry-exhaustion (repeated 503 → QueryTransportError) exercises the
      // failure path and emits the runId-source record with the surfaced error.
      const spy = vi.fn(async () => jsonResponse(503, undefined, 'gateway'));
      const result = await cockpitGateStatus(
        {
          issueRef: ISSUE_REF,
          gateType: GATE_TYPE,
          generation: GENERATION,
          runId: RUN_ID,
        },
        { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
      );
      expect(result.status).toBe('error');

      const rec = findRunIdSourceRecord(infoSpy);
      expect(rec).toBeDefined();
      if (!rec) return;
      expect(rec.runIdSource).toBe('explicit');
      expect(rec.resolvedStatus).toBe('error');
      expect(rec.gateId).toBeNull();
      expect(rec.error).toBeDefined();
      expect(typeof rec.error).toBe('string');
      expect(rec.error!.length).toBeGreaterThan(0);
      // Value privacy — runId still not present even on failure.
      expect(Object.keys(rec)).not.toContain('runId');
    } finally {
      infoSpy.mockRestore();
    }
  }, 10_000);

  it('failure path (4xx invalid-args): emits record with resolvedStatus:"error"', async () => {
    const logger = getLogger();
    const infoSpy = vi.spyOn(logger, 'info');
    try {
      const spy = vi.fn(async () => jsonResponse(400, undefined, 'bad shape'));
      const result = await cockpitGateStatus(
        {
          issueRef: ISSUE_REF,
          gateType: GATE_TYPE,
          generation: GENERATION,
        },
        { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
      );
      expect(result.status).toBe('error');

      const rec = findRunIdSourceRecord(infoSpy);
      expect(rec).toBeDefined();
      if (!rec) return;
      expect(rec.runIdSource).toBe('unset');
      expect(rec.resolvedStatus).toBe('error');
      expect(rec.gateId).toBeNull();
      expect(rec.error).toBeDefined();
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('cockpit_gate_list MUST NOT emit cockpit_gate_status.runid-source (Q3=C)', async () => {
    const logger = getLogger();
    const infoSpy = vi.spyOn(logger, 'info');
    try {
      const spy = vi.fn(async () => jsonResponse(200, { gates: [] }));
      const result = await cockpitGateList(
        {
          issueRef: ISSUE_REF,
          gateType: GATE_TYPE,
          runId: RUN_ID,
        },
        { ...BASE_DEPS, fetchImpl: spy as unknown as typeof fetch },
      );
      expect(result.status).toBe('ok');

      const rec = findRunIdSourceRecord(infoSpy);
      expect(rec, 'cockpit_gate_list must not emit the status record').toBeUndefined();
    } finally {
      infoSpy.mockRestore();
    }
  });
});
