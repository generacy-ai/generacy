import { z, ZodError } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
// Canonical frozen wire schemas (tetrad-development/docs/cockpit-remote-gates-plan.md
// § "Wire contracts"; generacy-cloud specs/843 gates-wire.md Shapes 1 & 2).
// GateOpenSchema  → up-path Shape 1 (type:'gate-open', flat, gateId/gateKey DERIVED
//                   by the cockpit_gate_open MCP tool before the POST reaches here).
// GateOutcomeSchema → up-path Shape 2, THE ACK (type:'gate-outcome', outcome enum,
//                   detail?, at) — replaces the removed gate-ack.
import { GateOpenSchema, GateOutcomeSchema, GateTypeSchema, type GateType } from '@generacy-ai/cockpit';
import type {
  ClusterRelayClient,
  RelayMessage,
} from '../types/relay.js';
import type { RetainedCockpitEvents } from './retained-cockpit-events.js';
import {
  CloudRequestError,
  CloudTransportError,
  type CloudGateListEntry,
  type CloudGateListResponse,
  type CloudGateQueryClient,
  type CloudGateStatusResponse,
} from '../services/cloud-gate-query-client.js';

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
  /**
   * #1038 — resolver for the cluster→cloud gate-query client backing
   * `GET /cockpit/gates`. Returning `null` disables the GET handler (503).
   * Resolves lazily so orchestrator startup order (relay bridge, activation)
   * does not force the client into being constructed at route-setup time.
   */
  getCloudGateQueryClient?: () => CloudGateQueryClient | null;
}

// ---------------------------------------------------------------------------
// #1038 — GET /cockpit/gates query surface
// ---------------------------------------------------------------------------

/**
 * Query-string schema for `GET /cockpit/gates` (data-model.md § Query-string
 * schema). `.strict()` + `.refine(...)` enforce: presence of `generation`
 * implies presence of `gateType`.
 */
const GateQueryStringSchema = z
  .object({
    issueRef: z.string().min(1),
    gateType: GateTypeSchema.optional(),
    generation: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => v.generation === undefined || v.gateType !== undefined, {
    message: 'gateType is required when generation is present',
  });

/**
 * Seven-to-three collapse (data-model.md § Gate status vocabulary; Q2 → C).
 * Cloud `delivered | applied` collapse to MCP-facing `answered`; terminal
 * negatives collapse to `absent`.
 */
type ThreeState = 'open' | 'answered' | 'absent';

function collapseCloudStatus(status: CloudGateStatusResponse['status']): ThreeState {
  switch (status) {
    case 'open':
      return 'open';
    case 'answered':
    case 'delivered':
    case 'applied':
      return 'answered';
    case 'superseded':
    case 'failed':
    case 'expired':
    case null:
    default:
      return 'absent';
  }
}

function collapseListEntryStatus(status: CloudGateListEntry['status']): 'open' | 'answered' | null {
  // Non-terminal filter (Q5 → A): drop terminal statuses before collapse.
  switch (status) {
    case 'open':
      return 'open';
    case 'answered':
    case 'delivered':
      return 'answered';
    case 'applied':
    case 'superseded':
    case 'failed':
    case 'expired':
    default:
      return null;
  }
}

interface StatusResponse {
  gateId: string | null;
  status: ThreeState;
}

interface ListResponseEntry {
  gateId: string;
  gateType: GateType;
  generation: string;
  status: 'open' | 'answered';
}

interface ListResponse {
  gates: ListResponseEntry[];
  truncated?: boolean;
}

function mapStatus(raw: CloudGateStatusResponse): StatusResponse {
  const mapped = collapseCloudStatus(raw.status);
  if (mapped === 'absent') return { gateId: null, status: 'absent' };
  return { gateId: raw.gateId, status: mapped };
}

function mapList(raw: CloudGateListResponse): ListResponse {
  const gates: ListResponseEntry[] = [];
  for (const entry of raw.gates) {
    const status = collapseListEntryStatus(entry.status);
    if (status === null) continue;
    gates.push({
      gateId: entry.gateId,
      gateType: entry.gateType,
      generation: entry.generation,
      status,
    });
  }
  const result: ListResponse = { gates };
  if (raw.truncated === true) result.truncated = true;
  return result;
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
  // #1038 — GET /cockpit/gates. Read-only pass-through to the cloud gate
  // store. Applies the seven-to-three cloud-status collapse (Q2 → C) and the
  // non-terminal filter for list-mode responses (Q5 → A). No side effects.
  server.get<{ Querystring: Record<string, string | undefined> }>(
    '/cockpit/gates',
    async (request, reply) => {
      const start = Date.now();
      const parsed = GateQueryStringSchema.safeParse(request.query);
      if (!parsed.success) {
        options.logger.warn(
          { route: 'GET /cockpit/gates', code: 'VALIDATION' },
          'Invalid gate-query querystring',
        );
        return reply.status(400).send({
          error: 'invalid-query',
          code: 'VALIDATION',
          details: parsed.error.issues,
        });
      }

      const client = options.getCloudGateQueryClient?.() ?? null;
      if (!client) {
        options.logger.warn(
          { route: 'GET /cockpit/gates' },
          'cloud gate-query client unavailable',
        );
        return reply.status(503).send({
          error: 'cloud-query-not-configured',
          code: 'UNAVAILABLE',
        });
      }

      const { issueRef, gateType, generation } = parsed.data;
      const mode: 'status' | 'list' = generation !== undefined ? 'status' : 'list';

      try {
        if (mode === 'status') {
          const raw = await client.getGateStatus({
            issueRef,
            gateType: gateType!,
            generation: generation!,
          });
          const body = mapStatus(raw);
          options.logger.info(
            {
              route: 'GET /cockpit/gates',
              mode,
              issueRef,
              gateType,
              mappedStatus: body.status,
              cloudDurationMs: Date.now() - start,
            },
            'cockpit gate-query ok',
          );
          return reply.status(200).send(body);
        }
        const raw = await client.listGates({ issueRef, ...(gateType ? { gateType } : {}) });
        const body = mapList(raw);
        options.logger.info(
          {
            route: 'GET /cockpit/gates',
            mode,
            issueRef,
            gateType,
            resultCount: body.gates.length,
            cloudDurationMs: Date.now() - start,
          },
          'cockpit gate-query ok',
        );
        return reply.status(200).send(body);
      } catch (err) {
        if (err instanceof CloudTransportError) {
          options.logger.warn(
            {
              route: 'GET /cockpit/gates',
              mode,
              issueRef,
              gateType,
              errorCode: 'CLOUD_UNREACHABLE',
              cloudDurationMs: Date.now() - start,
            },
            'cockpit gate-query cloud unreachable',
          );
          return reply.status(502).send({
            error: 'cloud-unreachable',
            code: 'CLOUD_UNREACHABLE',
            detail: err.message,
          });
        }
        if (err instanceof CloudRequestError) {
          options.logger.warn(
            {
              route: 'GET /cockpit/gates',
              mode,
              issueRef,
              gateType,
              errorCode: 'CLOUD_REQUEST_INVALID',
              cloudDurationMs: Date.now() - start,
            },
            'cockpit gate-query cloud request invalid',
          );
          return reply.status(500).send({
            error: 'cloud-request-invalid',
            code: 'CLOUD_REQUEST_INVALID',
            detail: err.message,
          });
        }
        throw err;
      }
    },
  );

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
