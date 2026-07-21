import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { setupCockpitAnswersRoute } from '../cockpit-answers.js';
import type { CockpitAnswersWriter } from '../../services/cockpit-answers-writer.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

interface FakeWriter {
  isHealthy: ReturnType<typeof vi.fn>;
  hasDelivered: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
}

function makeFakeWriter(overrides: Partial<FakeWriter> = {}): FakeWriter {
  return {
    isHealthy: vi.fn(() => true),
    hasDelivered: vi.fn(() => false),
    append: vi.fn(async () => ({ deduped: false })),
    ...overrides,
  };
}

const validAnswer = {
  kind: 'gate-answer',
  deliveryId: 'dlv_1',
  gateId: 'g_1',
  generation: 0,
  answeredAt: '2026-07-21T15:04:11.100Z',
  answer: { choice: 'proceed' },
};

describe('POST /cockpit/answers', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    server = Fastify();
  });

  it('fresh delivery — appends and returns deduped:false', async () => {
    const writer = makeFakeWriter();
    setupCockpitAnswersRoute(server, {
      writer: writer as unknown as CockpitAnswersWriter,
      logger: silentLogger,
    });
    await server.ready();

    const res = await server.inject({
      method: 'POST',
      url: '/cockpit/answers',
      payload: validAnswer,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ accepted: true, deduped: false });
    expect(writer.append).toHaveBeenCalledTimes(1);
    expect(writer.append).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: 'dlv_1',
      gateId: 'g_1',
    }));
  });

  it('duplicate deliveryId — returns deduped:true and does not append', async () => {
    const writer = makeFakeWriter({ hasDelivered: vi.fn(() => true) });
    setupCockpitAnswersRoute(server, {
      writer: writer as unknown as CockpitAnswersWriter,
      logger: silentLogger,
    });
    await server.ready();

    const res = await server.inject({
      method: 'POST',
      url: '/cockpit/answers',
      payload: validAnswer,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ accepted: true, deduped: true });
    expect(writer.append).not.toHaveBeenCalled();
  });

  it('400 on schema failure — nothing written', async () => {
    const writer = makeFakeWriter();
    setupCockpitAnswersRoute(server, {
      writer: writer as unknown as CockpitAnswersWriter,
      logger: silentLogger,
    });
    await server.ready();

    const res = await server.inject({
      method: 'POST',
      url: '/cockpit/answers',
      payload: { kind: 'gate-answer' /* missing everything else */ },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('VALIDATION');
    expect(writer.append).not.toHaveBeenCalled();
  });

  it('503 when writer is unhealthy', async () => {
    const writer = makeFakeWriter({ isHealthy: vi.fn(() => false) });
    setupCockpitAnswersRoute(server, {
      writer: writer as unknown as CockpitAnswersWriter,
      logger: silentLogger,
    });
    await server.ready();

    const res = await server.inject({
      method: 'POST',
      url: '/cockpit/answers',
      payload: validAnswer,
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('ANSWERS_FILE_UNAVAILABLE');
    expect(writer.hasDelivered).not.toHaveBeenCalled();
    expect(writer.append).not.toHaveBeenCalled();
  });

  it('concurrent deliveries with same deliveryId append exactly once', async () => {
    // Emulates the real writer's mutex-scoped dedup: both requests race past
    // the route-level hasDelivered() pre-check, then serialize inside append()
    // and the second call sees the deliveryId already present.
    let appendedCount = 0;
    const delivered = new Set<string>();
    let chain: Promise<void> = Promise.resolve();
    const writer = {
      isHealthy: () => true,
      hasDelivered: (id: string) => delivered.has(id),
      append: (payload: { deliveryId: string }) => {
        const previous = chain;
        let release: () => void = () => {};
        const next = new Promise<void>((r) => {
          release = r;
        });
        chain = previous.then(() => next);
        return previous.then(async () => {
          try {
            await new Promise((resolve) => setTimeout(resolve, 10));
            if (delivered.has(payload.deliveryId)) {
              return { deduped: true };
            }
            delivered.add(payload.deliveryId);
            appendedCount += 1;
            return { deduped: false };
          } finally {
            release();
          }
        });
      },
    };
    setupCockpitAnswersRoute(server, {
      writer: writer as unknown as CockpitAnswersWriter,
      logger: silentLogger,
    });
    await server.ready();

    const [r1, r2] = await Promise.all([
      server.inject({ method: 'POST', url: '/cockpit/answers', payload: validAnswer }),
      server.inject({ method: 'POST', url: '/cockpit/answers', payload: validAnswer }),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 200]);
    const b1 = JSON.parse(r1.body);
    const b2 = JSON.parse(r2.body);
    // Exactly one write happened at the writer level — the mutex-scoped
    // dedup check inside append() blocks the second request.
    expect(appendedCount).toBe(1);
    // Exactly one response reports deduped:false; the other reports deduped:true.
    const outcomes = [b1.deduped, b2.deduped].sort();
    expect(outcomes).toEqual([false, true]);
  });
});
