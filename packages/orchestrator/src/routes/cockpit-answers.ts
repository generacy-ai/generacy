import { ZodError } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { GateAnswerEnvelopeSchema } from '@generacy-ai/cockpit';
import type { CockpitAnswersWriter } from '../services/cockpit-answers-writer.js';

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

export interface SetupCockpitAnswersRouteOptions {
  writer: CockpitAnswersWriter;
  logger: Logger;
}

export function setupCockpitAnswersRoute(
  server: FastifyInstance,
  options: SetupCockpitAnswersRouteOptions,
): void {
  server.post(
    '/cockpit/answers',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!options.writer.isHealthy()) {
        return reply.status(503).send({
          error: 'answers-file writer not available',
          code: 'ANSWERS_FILE_UNAVAILABLE',
        });
      }

      try {
        const parsed = GateAnswerEnvelopeSchema.parse(request.body);
        // Fast path: avoid the mutex acquisition when we can already tell
        // this deliveryId is a duplicate. The authoritative check happens
        // inside append() under its mutex so concurrent redeliveries of the
        // same deliveryId can't both slip past the pre-check and double-write.
        if (options.writer.hasDelivered(parsed.deliveryId)) {
          options.logger.debug(
            { deliveryId: parsed.deliveryId, gateId: parsed.gateId },
            'cockpit answer deduped',
          );
          return reply.status(200).send({ accepted: true, deduped: true });
        }
        const { deduped } = await options.writer.append(parsed);
        if (deduped) {
          options.logger.debug(
            { deliveryId: parsed.deliveryId, gateId: parsed.gateId },
            'cockpit answer deduped',
          );
        }
        return reply.status(200).send({ accepted: true, deduped });
      } catch (err) {
        if (err instanceof ZodError) {
          options.logger.warn(
            {
              route: '/cockpit/answers',
              code: 'VALIDATION',
              issues: err.issues,
            },
            'Invalid gate-answer payload',
          );
          return reply.status(400).send({
            error: 'Invalid gate-answer payload',
            code: 'VALIDATION',
            details: err.issues,
          });
        }
        throw err;
      }
    },
  );
}
