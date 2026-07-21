import { ZodError } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { GateOpenSchema, GateAckSchema } from '@generacy-ai/cockpit';
import type {
  ClusterRelayClient,
  RelayMessage,
} from '../types/relay.js';
import type { RetainedCockpitEvents } from './retained-cockpit-events.js';

interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface SetupCockpitGatesRouteOptions {
  retainer: RetainedCockpitEvents;
  getRelayClient: () => ClusterRelayClient | null;
  logger: Logger;
}

interface EmitContext {
  data: unknown;
  timestamp: string;
  approxBytes: number;
  gateId: string;
  kind: string;
}

function tryEmitOrRetain(
  ctx: EmitContext,
  options: SetupCockpitGatesRouteOptions,
): { retained: boolean; retainQueue: { count: number; bytes: number } | null } {
  const client = options.getRelayClient();
  if (client && client.isConnected) {
    client.send({
      type: 'event',
      event: 'cluster.cockpit',
      data: ctx.data,
      timestamp: ctx.timestamp,
    } as unknown as RelayMessage);
    options.logger.info(
      { gateId: ctx.gateId, kind: ctx.kind },
      'cockpit gate emitted',
    );
    return { retained: false, retainQueue: null };
  }
  const { droppedCount } = options.retainer.enqueue({
    event: 'cluster.cockpit',
    data: ctx.data,
    timestamp: ctx.timestamp,
    approxBytes: ctx.approxBytes,
  });
  if (droppedCount > 0) {
    options.logger.warn(
      { dropped: droppedCount },
      'cluster.cockpit retain queue overflow',
    );
  }
  options.logger.debug(
    { gateId: ctx.gateId, kind: ctx.kind },
    'retained cockpit event queued',
  );
  return { retained: true, retainQueue: options.retainer.size() };
}

export function setupCockpitGatesRoute(
  server: FastifyInstance,
  options: SetupCockpitGatesRouteOptions,
): void {
  server.post(
    '/cockpit/gates',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const parsed = GateOpenSchema.parse(request.body);
        const timestamp = new Date().toISOString();
        const approxBytes = JSON.stringify(parsed).length;
        const outcome = tryEmitOrRetain(
          {
            data: parsed,
            timestamp,
            approxBytes,
            gateId: parsed.gateId,
            kind: parsed.kind,
          },
          options,
        );
        if (outcome.retained) {
          return reply.status(202).send({
            accepted: true,
            retained: true,
            retainQueue: outcome.retainQueue,
          });
        }
        return reply.status(202).send({ accepted: true, retained: false });
      } catch (err) {
        if (err instanceof ZodError) {
          options.logger.warn(
            { route: '/cockpit/gates', code: 'VALIDATION' },
            'Invalid gate-open payload',
          );
          return reply.status(400).send({
            error: 'Invalid gate-open payload',
            code: 'VALIDATION',
            details: err.issues,
          });
        }
        throw err;
      }
    },
  );

  server.post<{ Params: { id: string } }>(
    '/cockpit/gates/:id/ack',
    async (request, reply) => {
      const pathGateId = request.params.id;
      const body = request.body as Record<string, unknown> | null;

      if (
        typeof body === 'object' &&
        body !== null &&
        'gateId' in body &&
        body.gateId !== pathGateId
      ) {
        options.logger.warn(
          { route: '/cockpit/gates/:id/ack', code: 'VALIDATION' },
          'gateId in body does not match path parameter',
        );
        return reply.status(400).send({
          error: 'gateId in body does not match path parameter',
          code: 'VALIDATION',
          details: { pathGateId, bodyGateId: body.gateId },
        });
      }

      try {
        const merged = { ...(body ?? {}), gateId: pathGateId };
        const parsed = GateAckSchema.parse(merged);
        const timestamp = new Date().toISOString();
        const approxBytes = JSON.stringify(parsed).length;
        const outcome = tryEmitOrRetain(
          {
            data: parsed,
            timestamp,
            approxBytes,
            gateId: parsed.gateId,
            kind: parsed.kind,
          },
          options,
        );
        if (outcome.retained) {
          return reply.status(202).send({
            accepted: true,
            retained: true,
            retainQueue: outcome.retainQueue,
          });
        }
        return reply.status(202).send({ accepted: true, retained: false });
      } catch (err) {
        if (err instanceof ZodError) {
          options.logger.warn(
            { route: '/cockpit/gates/:id/ack', code: 'VALIDATION' },
            'Invalid gate-ack payload',
          );
          return reply.status(400).send({
            error: 'Invalid gate-ack payload',
            code: 'VALIDATION',
            details: err.issues,
          });
        }
        throw err;
      }
    },
  );
}
