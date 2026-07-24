import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { setupCockpitGatesRoute } from '../cockpit-gates.js';
import { createRetainedCockpitEvents } from '../retained-cockpit-events.js';
import type { ClusterRelayClient } from '../../types/relay.js';
import {
  CloudRequestError,
  CloudTransportError,
  type CloudGateQueryClient,
} from '../../services/cloud-gate-query-client.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeMockClient(overrides: Partial<ClusterRelayClient> = {}): ClusterRelayClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    isConnected: true,
    ...overrides,
  };
}

// Frozen up-path Shape 1 — gate-open. gateId is a 24-char hex (derived from
// gateKey by the cockpit_gate_open MCP tool); the route only validates + emits.
const GATE_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2';
const validOpen = {
  type: 'gate-open' as const,
  gateId: GATE_ID,
  gateKey: 'generacy-ai/generacy#1021:clarification:batch-1',
  gateType: 'clarification' as const,
  epicRef: 'generacy-ai/generacy#1000',
  issueRef: 'generacy-ai/generacy#1021',
  issueTitle: 'Do the thing',
  issueUrl: 'https://github.com/generacy-ai/generacy/issues/1021',
  title: 'Clarification needed',
  body: 'Please choose how to proceed.',
  options: [
    { id: 'proceed', label: 'Proceed' },
    { id: 'hold', label: 'Hold', description: 'Wait for review' },
  ],
  allowFreeText: true,
  sessionId: 'sess_1',
  askedAt: '2026-07-21T15:04:05.123Z',
};

function openWithGateId(gateId: string) {
  return { ...validOpen, gateId };
}

// Frozen up-path Shape 2 — gate-outcome (THE ACK). The MCP client posts only the
// semantic ack; the route stamps type + path gateId and defaults `at`.
const validAckBody = {
  outcome: 'applied' as const,
  detail: 'answer applied to the issue',
  at: '2026-07-21T15:04:11.900Z',
};

describe('cockpit gates routes', () => {
  let server: FastifyInstance;
  let retainer: ReturnType<typeof createRetainedCockpitEvents>;

  beforeEach(async () => {
    server = Fastify();
    retainer = createRetainedCockpitEvents({ maxCount: 100, maxBytes: 100_000 });
  });

  describe('POST /cockpit/gates (open)', () => {
    it('happy path connected — sends the frozen gate-open on relay, retained:false', async () => {
      const client = makeMockClient();
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => client,
        logger: silentLogger,
      });
      await server.ready();

      const res = await server.inject({
        method: 'POST',
        url: '/cockpit/gates',
        payload: validOpen,
      });
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body)).toEqual({ accepted: true, retained: false });

      const call = (client.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        type: string;
        event: string;
        data: { type: string; gateId: string; gateType: string };
        timestamp: string;
      };
      expect(call.type).toBe('event');
      expect(call.event).toBe('cluster.cockpit');
      // The emitted relay data carries `type` as the cloud subtype discriminator.
      expect(call.data).toMatchObject(validOpen);
      expect(call.data.type).toBe('gate-open');
      expect(typeof call.timestamp).toBe('string');
    });

    it('happy path disconnected — enqueues, returns retained:true + retainQueue', async () => {
      const client = makeMockClient({ isConnected: false });
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => client,
        logger: silentLogger,
      });
      await server.ready();

      const res = await server.inject({
        method: 'POST',
        url: '/cockpit/gates',
        payload: validOpen,
      });
      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body);
      expect(body.accepted).toBe(true);
      expect(body.retained).toBe(true);
      expect(body.retainQueue.count).toBe(1);
      expect(body.retainQueue.bytes).toBeGreaterThan(0);
      expect(client.send).not.toHaveBeenCalled();
    });

    it('null client — enqueues', async () => {
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => null,
        logger: silentLogger,
      });
      await server.ready();

      const res = await server.inject({
        method: 'POST',
        url: '/cockpit/gates',
        payload: validOpen,
      });
      expect(res.statusCode).toBe(202);
      expect(retainer.size().count).toBe(1);
    });

    it('400 on schema failure (bare type is not a full gate-open)', async () => {
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => makeMockClient(),
        logger: silentLogger,
      });
      await server.ready();

      const res = await server.inject({
        method: 'POST',
        url: '/cockpit/gates',
        payload: { type: 'gate-open' /* missing everything else */ },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION');
      expect(Array.isArray(body.details)).toBe(true);
    });

    it('400 when gateType is not one of the 8 frozen enum values', async () => {
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => makeMockClient(),
        logger: silentLogger,
      });
      await server.ready();

      const res = await server.inject({
        method: 'POST',
        url: '/cockpit/gates',
        // 'clarification-batch' is the ledger original-action, NOT a gateType.
        payload: { ...validOpen, gateType: 'clarification-batch' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('VALIDATION');
    });

    it('400 when issueUrl is a bare ref rather than a URL', async () => {
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => makeMockClient(),
        logger: silentLogger,
      });
      await server.ready();

      const res = await server.inject({
        method: 'POST',
        url: '/cockpit/gates',
        payload: { ...validOpen, issueUrl: 'generacy-ai/generacy#1021' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('warn fires on overflow drops', async () => {
      retainer = createRetainedCockpitEvents({ maxCount: 1, maxBytes: 100_000 });
      const warn = vi.fn();
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => makeMockClient({ isConnected: false }),
        logger: { ...silentLogger, warn },
      });
      await server.ready();

      await server.inject({ method: 'POST', url: '/cockpit/gates', payload: validOpen });
      const res = await server.inject({
        method: 'POST',
        url: '/cockpit/gates',
        payload: openWithGateId('a1b2c3d4e5f6a7b8c9d0e100'),
      });
      expect(res.statusCode).toBe(202);
      expect(warn).toHaveBeenCalled();
    });

    it('order preserved when multiple posts arrive during a disconnect', async () => {
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => makeMockClient({ isConnected: false }),
        logger: silentLogger,
      });
      await server.ready();

      const ids = [
        'a1b2c3d4e5f6a7b8c9d0e1a0',
        'a1b2c3d4e5f6a7b8c9d0e1a1',
        'a1b2c3d4e5f6a7b8c9d0e1a2',
      ];
      for (const id of ids) {
        await server.inject({
          method: 'POST',
          url: '/cockpit/gates',
          payload: openWithGateId(id),
        });
      }
      expect(retainer.size().count).toBe(3);
      const drainClient = makeMockClient();
      const drainResult = retainer.drainInto(drainClient);
      expect(drainResult.sent).toBe(3);
      const seqs = (drainClient.send as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => ((call[0] as { data: { gateId: string } }).data.gateId),
      );
      expect(seqs).toEqual(ids);
    });
  });

  describe('POST /cockpit/gates/:id/ack (gate-outcome)', () => {
    it('happy path — stamps type:gate-outcome + path gateId and emits', async () => {
      const client = makeMockClient();
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => client,
        logger: silentLogger,
      });
      await server.ready();

      const res = await server.inject({
        method: 'POST',
        url: `/cockpit/gates/${GATE_ID}/ack`,
        payload: validAckBody,
      });
      expect(res.statusCode).toBe(202);
      const call = (client.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        data: { type: string; gateId: string; outcome: string; detail?: string; at: string };
      };
      expect(call.data.type).toBe('gate-outcome');
      expect(call.data.gateId).toBe(GATE_ID);
      expect(call.data.outcome).toBe('applied');
      expect(call.data.detail).toBe('answer applied to the issue');
      // No leftover gate-ack fields on the wire.
      expect(call.data).not.toHaveProperty('kind');
      expect(call.data).not.toHaveProperty('generation');
      expect(call.data).not.toHaveProperty('ackedAt');
    });

    it('defaults `at` when the client omits it', async () => {
      const client = makeMockClient();
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => client,
        logger: silentLogger,
      });
      await server.ready();

      const res = await server.inject({
        method: 'POST',
        url: `/cockpit/gates/${GATE_ID}/ack`,
        payload: { outcome: 'superseded' },
      });
      expect(res.statusCode).toBe(202);
      const call = (client.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        data: { outcome: string; at: string };
      };
      expect(call.data.outcome).toBe('superseded');
      expect(typeof call.data.at).toBe('string');
      expect(Number.isNaN(Date.parse(call.data.at))).toBe(false);
    });

    it('400 when body.gateId differs from path :id', async () => {
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => makeMockClient(),
        logger: silentLogger,
      });
      await server.ready();

      const res = await server.inject({
        method: 'POST',
        url: `/cockpit/gates/${GATE_ID}/ack`,
        payload: { ...validAckBody, gateId: 'b0b0b0b0b0b0b0b0b0b0b0b0' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION');
      expect(body.details).toEqual({
        pathGateId: GATE_ID,
        bodyGateId: 'b0b0b0b0b0b0b0b0b0b0b0b0',
      });
    });

    it('accepts body.gateId when it matches path :id', async () => {
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => makeMockClient(),
        logger: silentLogger,
      });
      await server.ready();

      const res = await server.inject({
        method: 'POST',
        url: `/cockpit/gates/${GATE_ID}/ack`,
        payload: { ...validAckBody, gateId: GATE_ID },
      });
      expect(res.statusCode).toBe(202);
    });

    it('400 on gate-outcome schema failure (missing outcome)', async () => {
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => makeMockClient(),
        logger: silentLogger,
      });
      await server.ready();

      const res = await server.inject({
        method: 'POST',
        url: `/cockpit/gates/${GATE_ID}/ack`,
        payload: { detail: 'no outcome here' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('VALIDATION');
    });

    it('400 when outcome is outside the applied|superseded|failed enum', async () => {
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => makeMockClient(),
        logger: silentLogger,
      });
      await server.ready();

      const res = await server.inject({
        method: 'POST',
        url: `/cockpit/gates/${GATE_ID}/ack`,
        payload: { outcome: 'answered' }, // old free-string value, now rejected
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // #1038 — read-only query surface. All these branches consume the same
  // injected `CloudGateQueryClient` and never touch the retainer or relay.
  describe('GET /cockpit/gates (query)', () => {
    function makeMockQueryClient(
      overrides: Partial<CloudGateQueryClient> = {},
    ): CloudGateQueryClient {
      return {
        getGateStatus: vi.fn(),
        listGates: vi.fn(),
        ...overrides,
      };
    }

    function wire(
      client: CloudGateQueryClient | null,
    ) {
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => makeMockClient(),
        logger: silentLogger,
        getCloudGateQueryClient: () => client,
      });
    }

    // ---- status-mode collapse (SC-002/Q2→C mapping) ---------------------

    it('status: cloud "open" → { gateId, status: "open" }', async () => {
      const gateId = 'a'.repeat(24);
      const client = makeMockQueryClient({
        getGateStatus: vi.fn().mockResolvedValue({ gateId, status: 'open' }),
      });
      wire(client);
      await server.ready();
      const res = await server.inject({
        method: 'GET',
        url: `/cockpit/gates?issueRef=${encodeURIComponent('gen/rep#1')}&gateType=clarification&generation=abc`,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ gateId, status: 'open' });
    });

    it.each([
      ['answered', 'answered'],
      ['delivered', 'answered'],
      ['applied', 'answered'],
    ] as const)(
      'status: cloud "%s" → three-state "%s"',
      async (cloudStatus, expected) => {
        const gateId = 'b'.repeat(24);
        const client = makeMockQueryClient({
          getGateStatus: vi.fn().mockResolvedValue({ gateId, status: cloudStatus }),
        });
        wire(client);
        await server.ready();
        const res = await server.inject({
          method: 'GET',
          url: `/cockpit/gates?issueRef=${encodeURIComponent('gen/rep#1')}&gateType=clarification&generation=x`,
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ gateId, status: expected });
      },
    );

    it.each([
      ['superseded'],
      ['failed'],
      ['expired'],
      [null],
    ] as const)(
      'status: cloud "%s" → { gateId: null, status: "absent" }',
      async (cloudStatus) => {
        const client = makeMockQueryClient({
          getGateStatus: vi
            .fn()
            .mockResolvedValue({ gateId: cloudStatus === null ? null : 'c'.repeat(24), status: cloudStatus }),
        });
        wire(client);
        await server.ready();
        const res = await server.inject({
          method: 'GET',
          url: `/cockpit/gates?issueRef=${encodeURIComponent('gen/rep#1')}&gateType=clarification&generation=x`,
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ gateId: null, status: 'absent' });
      },
    );

    // ---- list-mode filter + collapse -----------------------------------

    it('list: filters terminal cloud statuses and collapses delivered → answered', async () => {
      const client = makeMockQueryClient({
        listGates: vi.fn().mockResolvedValue({
          gates: [
            { gateId: 'a'.repeat(24), gateType: 'clarification', generation: 'g1', status: 'open' },
            { gateId: 'b'.repeat(24), gateType: 'implementation-review', generation: 'g2', status: 'delivered' },
            { gateId: 'c'.repeat(24), gateType: 'implementation-review', generation: 'g3', status: 'applied' },
            { gateId: 'd'.repeat(24), gateType: 'clarification', generation: 'g4', status: 'superseded' },
          ],
        }),
      });
      wire(client);
      await server.ready();
      const res = await server.inject({
        method: 'GET',
        url: `/cockpit/gates?issueRef=${encodeURIComponent('gen/rep#1')}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.gates).toHaveLength(2); // open + delivered survive
      expect(body.gates[0].status).toBe('open');
      expect(body.gates[1].status).toBe('answered'); // delivered collapsed
      // truncated omitted (not `false`)
      expect('truncated' in body).toBe(false);
    });

    it('list: passes gateType filter through to client', async () => {
      const listGates = vi.fn().mockResolvedValue({ gates: [] });
      const client = makeMockQueryClient({ listGates });
      wire(client);
      await server.ready();
      const res = await server.inject({
        method: 'GET',
        url: `/cockpit/gates?issueRef=${encodeURIComponent('gen/rep#1')}&gateType=clarification`,
      });
      expect(res.statusCode).toBe(200);
      expect(listGates).toHaveBeenCalledWith({
        issueRef: 'gen/rep#1',
        gateType: 'clarification',
      });
    });

    it('list: truncated:true survives, absent otherwise', async () => {
      const client = makeMockQueryClient({
        listGates: vi
          .fn()
          .mockResolvedValue({ gates: [], truncated: true }),
      });
      wire(client);
      await server.ready();
      const res = await server.inject({
        method: 'GET',
        url: `/cockpit/gates?issueRef=${encodeURIComponent('gen/rep#1')}`,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).truncated).toBe(true);
    });

    // ---- 400 validation branches ---------------------------------------

    it('400 when generation is present without gateType', async () => {
      wire(makeMockQueryClient());
      await server.ready();
      const res = await server.inject({
        method: 'GET',
        url: `/cockpit/gates?issueRef=${encodeURIComponent('gen/rep#1')}&generation=abc`,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('VALIDATION');
    });

    it('400 on missing issueRef', async () => {
      wire(makeMockQueryClient());
      await server.ready();
      const res = await server.inject({
        method: 'GET',
        url: `/cockpit/gates?gateType=clarification`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 on unknown gateType', async () => {
      wire(makeMockQueryClient());
      await server.ready();
      const res = await server.inject({
        method: 'GET',
        url: `/cockpit/gates?issueRef=${encodeURIComponent('gen/rep#1')}&gateType=not-a-real-type`,
      });
      expect(res.statusCode).toBe(400);
    });

    // ---- upstream error branches ---------------------------------------

    it('502 when CloudGateQueryClient throws CloudTransportError', async () => {
      const client = makeMockQueryClient({
        getGateStatus: vi.fn().mockRejectedValue(new CloudTransportError('boom')),
      });
      wire(client);
      await server.ready();
      const res = await server.inject({
        method: 'GET',
        url: `/cockpit/gates?issueRef=${encodeURIComponent('gen/rep#1')}&gateType=clarification&generation=abc`,
      });
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.body).code).toBe('CLOUD_UNREACHABLE');
    });

    it('500 on CloudRequestError', async () => {
      const client = makeMockQueryClient({
        getGateStatus: vi.fn().mockRejectedValue(new CloudRequestError('bad body')),
      });
      wire(client);
      await server.ready();
      const res = await server.inject({
        method: 'GET',
        url: `/cockpit/gates?issueRef=${encodeURIComponent('gen/rep#1')}&gateType=clarification&generation=abc`,
      });
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).code).toBe('CLOUD_REQUEST_INVALID');
    });

    it('503 when no CloudGateQueryClient is configured', async () => {
      // Use the setup path that omits getCloudGateQueryClient entirely.
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => makeMockClient(),
        logger: silentLogger,
      });
      await server.ready();
      const res = await server.inject({
        method: 'GET',
        url: `/cockpit/gates?issueRef=${encodeURIComponent('gen/rep#1')}&gateType=clarification&generation=abc`,
      });
      expect(res.statusCode).toBe(503);
    });

    // ---- regression: POST handlers untouched ---------------------------

    it('does not affect the POST /cockpit/gates path', async () => {
      const client = makeMockClient();
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => client,
        logger: silentLogger,
        getCloudGateQueryClient: () => makeMockQueryClient(),
      });
      await server.ready();
      const res = await server.inject({
        method: 'POST',
        url: '/cockpit/gates',
        payload: validOpen,
      });
      expect(res.statusCode).toBe(202);
      expect(client.send).toHaveBeenCalled();
    });
  });
});
