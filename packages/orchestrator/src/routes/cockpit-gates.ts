import { ZodError } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
// Canonical frozen wire schemas (tetrad-development/docs/cockpit-remote-gates-plan.md
// § "Wire contracts"; generacy-cloud specs/843 gates-wire.md Shapes 1 & 2).
// GateOpenSchema  → up-path Shape 1 (type:'gate-open', flat, gateId/gateKey DERIVED
//                   by the cockpit_gate_open MCP tool before the POST reaches here).
// GateOutcomeSchema → up-path Shape 2, THE ACK (type:'gate-outcome', outcome enum,
//                   detail?, at) — replaces the removed gate-ack.
import { GateOpenSchema, GateOutcomeSchema } from '@generacy-ai/cockpit';
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
  // Cloud sub-event discriminator (message-handler.ts:721): 'gate-open' | 'gate-outcome'.
  type: string;
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
      { gateId: ctx.gateId, type: ctx.type },
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
    { gateId: ctx.gateId, type: ctx.type },
    'retained cockpit event queued',
  );
  return { retained: true, retainQueue: options.retainer.size() };
}

export function setupCockpitGatesRoute(
  server: FastifyInstance,
  options: SetupCockpitGatesRouteOptions,
): void {
  // Up-path Shape 1 — gate-open. Body is the fully-assembled frozen record
  // (type:'gate-open', derived gateId/gateKey, gateType, presentation fields);
  // the route validates and forwards it verbatim onto the relay.
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
            type: parsed.type,
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

  // Up-path Shape 2 — gate-outcome (THE ACK). The MCP client (cockpit_gate_ack)
  // POSTs the semantic ack ({ outcome, detail? }); the route stamps
  // type:'gate-outcome' + the path gateId, defaults `at`, validates against the
  // frozen GateOutcomeSchema, and emits it as the 'gate-outcome' cloud subtype.
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
        // Build the frozen gate-outcome record. Path `:id` is authoritative for
        // gateId; `type` is always 'gate-outcome' (never client-supplied); `at`
        // defaults to now when the client omits it. `kind`/`generation`/`ackedAt`
        // from the old gate-ack shape are dropped — GateOutcomeSchema is closed.
        const candidate = {
          ...(body ?? {}),
          type: 'gate-outcome' as const,
          gateId: pathGateId,
          at:
            typeof body?.at === 'string' && body.at.length > 0
              ? body.at
              : new Date().toISOString(),
        };
        const parsed = GateOutcomeSchema.parse(candidate);
        const timestamp = new Date().toISOString();
        const approxBytes = JSON.stringify(parsed).length;
        const outcome = tryEmitOrRetain(
          {
            data: parsed,
            timestamp,
            approxBytes,
            gateId: parsed.gateId,
            type: parsed.type,
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
            'Invalid gate-outcome payload',
          );
          return reply.status(400).send({
            error: 'Invalid gate-outcome payload',
            code: 'VALIDATION',
            details: err.issues,
          });
        }
        throw err;
      }
    },
  );
}
