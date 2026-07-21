import { z } from 'zod';
import {
  ArtifactReviewKindSchema,
  ARTIFACT_REVIEW_KINDS,
  GateOutcomeSchema,
  GATE_OUTCOMES,
  GateTypeSchema,
  GATE_TYPES,
  type ArtifactReviewKind,
  type GateOutcome,
  type GateType,
} from './types.js';

export const IssueRefSchema = z.object({
  owner: z.string().min(1).regex(/^[a-zA-Z0-9-_.]+$/),
  repo: z.string().min(1).regex(/^[a-zA-Z0-9-_.]+$/),
  number: z.number().int().positive(),
});
export type IssueRef = z.infer<typeof IssueRefSchema>;

export const ActorSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  displayName: z.string().min(1),
});
export type Actor = z.infer<typeof ActorSchema>;

export const GateOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  recommended: z.boolean().optional(),
});
export type GateOption = z.infer<typeof GateOptionSchema>;

export const GateRecordSchema = z.object({
  gateId: z.string().regex(/^[0-9a-f]{24}$/),
  gateKey: z.string().min(1),
  gateType: GateTypeSchema,

  epicRef: IssueRefSchema,
  issueRef: IssueRefSchema,
  issueTitle: z.string().min(1),
  issueUrl: z.string().url(),
  branch: z.string().min(1).optional(),
  prNumber: z.number().int().positive().optional(),

  title: z.string().min(1),
  body: z.string(),
  options: z.array(GateOptionSchema).min(0),
  allowFreeText: z.literal(true),

  sessionId: z.string().min(1),
  askedAt: z.string().datetime({ offset: true }),
});
export type GateRecord = z.infer<typeof GateRecordSchema>;

export const GateAnswerSchema = z
  .object({
    type: z.literal('gate-answer'),
    gateId: z.string().regex(/^[0-9a-f]{24}$/),
    gateKey: z.string().min(1),
    optionId: z.string().min(1).nullable(),
    freeText: z.string().optional(),
    actor: ActorSchema,
    answeredAt: z.string().datetime({ offset: true }),
    deliveryId: z.string().min(1),
  })
  .refine(
    (v) => v.optionId !== null || (v.freeText !== undefined && v.freeText.length > 0),
    { message: 'optionId=null requires a non-empty freeText' },
  );
export type GateAnswer = z.infer<typeof GateAnswerSchema>;

export const GateOutcomeAckSchema = z.object({
  gateId: z.string().regex(/^[0-9a-f]{24}$/),
  outcome: GateOutcomeSchema,
  detail: z.string().min(1).optional(),
  at: z.string().datetime({ offset: true }),
});
export type GateOutcomeAck = z.infer<typeof GateOutcomeAckSchema>;

export {
  ArtifactReviewKindSchema,
  ARTIFACT_REVIEW_KINDS,
  GateOutcomeSchema,
  GATE_OUTCOMES,
  GateTypeSchema,
  GATE_TYPES,
  type ArtifactReviewKind,
  type GateOutcome,
  type GateType,
};
