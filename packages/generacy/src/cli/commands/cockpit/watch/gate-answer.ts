/**
 * `gate-answer` — new `CockpitStreamEvent` variant + wire schema for operator
 * gate answers tailed from `/workspaces/.generacy/cockpit/answers.ndjson`.
 *
 * Contract: `specs/1023-part-cockpit-remote-gates/contracts/gate-answer-event.md`,
 * `specs/1023-part-cockpit-remote-gates/contracts/gate-answer-line.md`.
 */
import { z } from 'zod';

export const GateAnswerLineSchema = z
  .object({
    gateId: z.string().min(1),
    deliveryId: z.string().min(1),
    scope: z.object({
      owner: z.string().min(1),
      repo: z.string().min(1),
      number: z.number().int().positive(),
    }),
    answer: z.unknown(),
    answeredAt: z.string().datetime(),
    answeredBy: z.string().optional(),
    generation: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export type GateAnswerLine = z.infer<typeof GateAnswerLineSchema>;

export const GateAnswerEventSchema = z.object({
  type: z.literal('gate-answer'),
  ts: z.string().datetime(),
  gateId: z.string().min(1),
  deliveryId: z.string().min(1),
  epic: z.string().regex(/^[^/]+\/[^/]+#\d+$/),
  line: GateAnswerLineSchema,
});

export type GateAnswerEvent = z.infer<typeof GateAnswerEventSchema>;
