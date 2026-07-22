import { z } from 'zod';

export const GateOpenSchema = z
  .object({
    kind: z.literal('gate-open'),
    gateId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    scope: z.object({}).passthrough(),
    openedAt: z.string().datetime(),
  })
  .passthrough();

export const GateAckSchema = z
  .object({
    kind: z.literal('gate-ack'),
    gateId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    outcome: z.string().min(1),
    ackedAt: z.string().datetime(),
  })
  .passthrough();

export const GateAnswerEnvelopeSchema = z
  .object({
    kind: z.literal('gate-answer'),
    deliveryId: z.string().min(1),
    gateId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    answeredAt: z.string().datetime(),
    answer: z.unknown(),
  })
  .passthrough();

export type GateOpen = z.infer<typeof GateOpenSchema>;
export type GateAck = z.infer<typeof GateAckSchema>;
export type GateAnswerEnvelope = z.infer<typeof GateAnswerEnvelopeSchema>;
