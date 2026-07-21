import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { setupCockpitGatesRoute } from '../cockpit-gates.js';
import { createRetainedCockpitEvents } from '../retained-cockpit-events.js';
import type { ClusterRelayClient } from '../../types/relay.js';

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

const validOpen = {
  kind: 'gate-open',
  gateId: 'g_test_1',
  generation: 0,
  scope: { owner: 'generacy-ai', repo: 'generacy', issueNumber: 1021 },
  openedAt: '2026-07-21T15:04:05.123Z',
  payload: { question: 'proceed?' },
};

const validAckBody = {
  kind: 'gate-ack',
  generation: 0,
  outcome: 'answered',
  ackedAt: '2026-07-21T15:04:11.900Z',
  answer: { choice: 'proceed' },
};

describe('cockpit gates routes', () => {
  let server: FastifyInstance;
  let retainer: ReturnType<typeof createRetainedCockpitEvents>;

  beforeEach(async () => {
    server = Fastify();
    retainer = createRetainedCockpitEvents({ maxCount: 100, maxBytes: 100_000 });
  });

  describe('POST /cockpit/gates (open)', () => {
    it('happy path connected — sends on relay, returns retained:false', async () => {
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
        data: unknown;
        timestamp: string;
      };
      expect(call.type).toBe('event');
      expect(call.event).toBe('cluster.cockpit');
      expect(call.data).toMatchObject(validOpen);
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

    it('400 on schema failure', async () => {
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => makeMockClient(),
        logger: silentLogger,
      });
      await server.ready();

      const res = await server.inject({
        method: 'POST',
        url: '/cockpit/gates',
        payload: { kind: 'gate-open' /* missing everything else */ },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION');
      expect(Array.isArray(body.details)).toBe(true);
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
        payload: { ...validOpen, gateId: 'g_test_2' },
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

      for (let i = 0; i < 3; i += 1) {
        await server.inject({
          method: 'POST',
          url: '/cockpit/gates',
          payload: { ...validOpen, gateId: `g_seq_${i}` },
        });
      }
      expect(retainer.size().count).toBe(3);
      const drainClient = makeMockClient();
      const drainResult = retainer.drainInto(drainClient);
      expect(drainResult.sent).toBe(3);
      const seqs = (drainClient.send as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => ((call[0] as { data: { gateId: string } }).data.gateId),
      );
      expect(seqs).toEqual(['g_seq_0', 'g_seq_1', 'g_seq_2']);
    });
  });

  describe('POST /cockpit/gates/:id/ack', () => {
    it('happy path — merges path gateId into body and emits', async () => {
      const client = makeMockClient();
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => client,
        logger: silentLogger,
      });
      await server.ready();

      const res = await server.inject({
        method: 'POST',
        url: '/cockpit/gates/g_test_ack/ack',
        payload: validAckBody,
      });
      expect(res.statusCode).toBe(202);
      const call = (client.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        data: { gateId: string };
      };
      expect(call.data.gateId).toBe('g_test_ack');
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
        url: '/cockpit/gates/g_path/ack',
        payload: { ...validAckBody, gateId: 'g_body' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION');
      expect(body.details).toEqual({ pathGateId: 'g_path', bodyGateId: 'g_body' });
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
        url: '/cockpit/gates/g_same/ack',
        payload: { ...validAckBody, gateId: 'g_same' },
      });
      expect(res.statusCode).toBe(202);
    });

    it('400 on ack schema failure', async () => {
      setupCockpitGatesRoute(server, {
        retainer,
        getRelayClient: () => makeMockClient(),
        logger: silentLogger,
      });
      await server.ready();

      const res = await server.inject({
        method: 'POST',
        url: '/cockpit/gates/g_x/ack',
        payload: { kind: 'gate-ack' /* missing outcome, generation, ackedAt */ },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
