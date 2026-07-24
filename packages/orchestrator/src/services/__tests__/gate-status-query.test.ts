import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GateQueryRequestMessage } from '@generacy-ai/cluster-relay';
import {
  GateStatusQueryService,
  QueryUnreachableError,
  MalformedCloudResponseError,
  type RelayClientForQuery,
  type InboundRelayMessage,
} from '../gate-status-query.js';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

interface FakeClient extends RelayClientForQuery {
  sent: unknown[];
}

function makeClient(connected = true): FakeClient {
  const sent: unknown[] = [];
  return {
    sent,
    send: (msg: unknown) => {
      sent.push(msg);
    },
    isConnected: connected,
  };
}

function correlationIdGenerator(prefix: string) {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

describe('GateStatusQueryService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('single-mode round-trip resolves with QuerySingleResult', async () => {
    const client = makeClient();
    const service = new GateStatusQueryService({
      getRelayClient: () => client,
      logger: noopLogger,
      generateCorrelationId: correlationIdGenerator('c'),
    });
    const p = service.querySingle({
      issueRef: 'owner/repo#1',
      gateType: 'clarification',
      generation: 'gen-1',
    });
    // Envelope should have been sent immediately.
    expect(client.sent).toHaveLength(1);
    const sentEnv = client.sent[0] as GateQueryRequestMessage;
    expect(sentEnv.type).toBe('gate_query_request');
    expect(sentEnv.mode).toBe('single');
    expect(sentEnv.correlationId).toBe('c-1');

    service.onRelayMessage({
      type: 'gate_query_response',
      correlationId: 'c-1',
      status: 'ok',
      payload: { mode: 'single', gateId: 'a'.repeat(24), status: 'open' },
    } as unknown as InboundRelayMessage);

    const result = await p;
    expect(result).toEqual({ gateId: 'a'.repeat(24), status: 'open' });
  });

  it('list-mode round-trip resolves with QueryListResult', async () => {
    const client = makeClient();
    const service = new GateStatusQueryService({
      getRelayClient: () => client,
      logger: noopLogger,
      generateCorrelationId: correlationIdGenerator('c'),
    });
    const p = service.queryList({ issueRef: 'owner/repo#1' });

    service.onRelayMessage({
      type: 'gate_query_response',
      correlationId: 'c-1',
      status: 'ok',
      payload: {
        mode: 'list',
        gates: [
          { gateId: 'a'.repeat(24), gateType: 'clarification', status: 'open' },
          { gateId: 'b'.repeat(24), gateType: 'implementation-review', status: 'answered' },
        ],
      },
    } as unknown as InboundRelayMessage);

    const result = await p;
    expect(result.gates).toHaveLength(2);
    expect(result.gates[0].status).toBe('open');
    expect(result.gates[1].status).toBe('answered');
  });

  it('drops responses with unknown correlationId silently', async () => {
    const client = makeClient();
    const service = new GateStatusQueryService({
      getRelayClient: () => client,
      logger: noopLogger,
      generateCorrelationId: correlationIdGenerator('c'),
      perAttemptTimeoutMs: 5000,
    });
    const p = service.querySingle({
      issueRef: 'owner/repo#1',
      gateType: 'clarification',
      generation: 'gen',
    });
    // Capture rejection outcome up-front so the reject isn't unhandled.
    const settle = p.then(
      () => ({ ok: true as const }),
      (err: Error) => ({ ok: false as const, err }),
    );
    // Stray response for a different correlationId — dropped.
    service.onRelayMessage({
      type: 'gate_query_response',
      correlationId: 'stray',
      status: 'ok',
      payload: { mode: 'single', gateId: 'x'.repeat(24), status: 'open' },
    } as unknown as InboundRelayMessage);
    // Original still pending; not immediately settled.
    await Promise.resolve();
    // Cleanup — expire the timer + observe the reject.
    await vi.advanceTimersByTimeAsync(5001);
    const outcome = await settle;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err).toBeInstanceOf(QueryUnreachableError);
  });

  it('timeout rejects with QueryUnreachableError', async () => {
    const client = makeClient();
    const service = new GateStatusQueryService({
      getRelayClient: () => client,
      logger: noopLogger,
      generateCorrelationId: correlationIdGenerator('c'),
      perAttemptTimeoutMs: 5000,
    });
    const p = service.querySingle({
      issueRef: 'owner/repo#1',
      gateType: 'clarification',
      generation: 'gen',
    });
    // Capture the rejection before advancing timers to avoid unhandled-rejection warnings.
    const settle = p.then(
      () => ({ ok: true as const }),
      (err: Error) => ({ ok: false as const, err }),
    );
    await vi.advanceTimersByTimeAsync(5001);
    const outcome = await settle;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.err).toBeInstanceOf(QueryUnreachableError);
      expect(outcome.err).toMatchObject({ attempts: 1 });
    }
  });

  it('relay disconnected at send time rejects immediately with QueryUnreachableError', async () => {
    const client = makeClient(false);
    const service = new GateStatusQueryService({
      getRelayClient: () => client,
      logger: noopLogger,
      generateCorrelationId: correlationIdGenerator('c'),
    });
    await expect(
      service.querySingle({
        issueRef: 'owner/repo#1',
        gateType: 'clarification',
        generation: 'g',
      }),
    ).rejects.toBeInstanceOf(QueryUnreachableError);
  });

  it("cloud response status='error' rejects with QueryUnreachableError carrying lastReason", async () => {
    const client = makeClient();
    const service = new GateStatusQueryService({
      getRelayClient: () => client,
      logger: noopLogger,
      generateCorrelationId: correlationIdGenerator('c'),
    });
    const p = service.querySingle({
      issueRef: 'owner/repo#1',
      gateType: 'clarification',
      generation: 'g',
    });
    service.onRelayMessage({
      type: 'gate_query_response',
      correlationId: 'c-1',
      status: 'error',
      error: 'firestore down',
    } as unknown as InboundRelayMessage);
    await expect(p).rejects.toMatchObject({
      lastReason: 'firestore down',
    });
  });

  it('malformed response (missing payload on status=ok) rejects with MalformedCloudResponseError', async () => {
    const client = makeClient();
    const service = new GateStatusQueryService({
      getRelayClient: () => client,
      logger: noopLogger,
      generateCorrelationId: correlationIdGenerator('c'),
    });
    const p = service.querySingle({
      issueRef: 'owner/repo#1',
      gateType: 'clarification',
      generation: 'g',
    });
    service.onRelayMessage({
      type: 'gate_query_response',
      correlationId: 'c-1',
      status: 'ok',
      // payload deliberately missing
    } as unknown as InboundRelayMessage);
    await expect(p).rejects.toBeInstanceOf(MalformedCloudResponseError);
  });

  it('routes 3 concurrent requests to their own responses', async () => {
    const client = makeClient();
    const service = new GateStatusQueryService({
      getRelayClient: () => client,
      logger: noopLogger,
      generateCorrelationId: correlationIdGenerator('c'),
    });
    const p1 = service.querySingle({
      issueRef: 'o/r#1',
      gateType: 'clarification',
      generation: 'g1',
    });
    const p2 = service.querySingle({
      issueRef: 'o/r#2',
      gateType: 'clarification',
      generation: 'g2',
    });
    const p3 = service.queryList({ issueRef: 'o/r#3' });

    expect(client.sent).toHaveLength(3);

    // Deliver replies in different order — must still route by correlationId.
    service.onRelayMessage({
      type: 'gate_query_response',
      correlationId: 'c-3',
      status: 'ok',
      payload: { mode: 'list', gates: [] },
    } as unknown as InboundRelayMessage);
    service.onRelayMessage({
      type: 'gate_query_response',
      correlationId: 'c-1',
      status: 'ok',
      payload: { mode: 'single', gateId: '1'.repeat(24), status: 'open' },
    } as unknown as InboundRelayMessage);
    service.onRelayMessage({
      type: 'gate_query_response',
      correlationId: 'c-2',
      status: 'ok',
      payload: { mode: 'single', gateId: '2'.repeat(24), status: 'answered' },
    } as unknown as InboundRelayMessage);

    await expect(p1).resolves.toMatchObject({ gateId: '1'.repeat(24), status: 'open' });
    await expect(p2).resolves.toMatchObject({ gateId: '2'.repeat(24), status: 'answered' });
    await expect(p3).resolves.toMatchObject({ gates: [] });
  });

  it('rejects with MalformedCloudResponseError when payload.mode mismatches request mode', async () => {
    const client = makeClient();
    const service = new GateStatusQueryService({
      getRelayClient: () => client,
      logger: noopLogger,
      generateCorrelationId: correlationIdGenerator('c'),
    });
    const p = service.querySingle({
      issueRef: 'o/r#1',
      gateType: 'clarification',
      generation: 'g',
    });
    service.onRelayMessage({
      type: 'gate_query_response',
      correlationId: 'c-1',
      status: 'ok',
      payload: { mode: 'list', gates: [] },
    } as unknown as InboundRelayMessage);
    await expect(p).rejects.toBeInstanceOf(MalformedCloudResponseError);
  });
});
