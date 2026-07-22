import { z } from 'zod';

export const GATE_TYPES = [
  'clarification',
  'artifact-review',
  'implementation-review',
  'manual-validation',
  'escalation',
  'phase-queue',
  'filing',
  'scope-drained',
] as const;

export const GateTypeSchema = z.enum(GATE_TYPES);
export type GateType = z.infer<typeof GateTypeSchema>;

export const ARTIFACT_REVIEW_KINDS = [
  'spec-review',
  'plan-review',
  'tasks-review',
  'clarification-review',
] as const;

export const ArtifactReviewKindSchema = z.enum(ARTIFACT_REVIEW_KINDS);
export type ArtifactReviewKind = z.infer<typeof ArtifactReviewKindSchema>;

export const GATE_OUTCOMES = ['applied', 'superseded', 'failed'] as const;
export const GateOutcomeSchema = z.enum(GATE_OUTCOMES);
export type GateOutcome = z.infer<typeof GateOutcomeSchema>;
