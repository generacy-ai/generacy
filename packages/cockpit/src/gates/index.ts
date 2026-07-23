// Canonical cockpit gate wire contract — single source is ./schema.ts.
// See tetrad-development/docs/cockpit-remote-gates-plan.md § "Wire contracts".

export {
  // Wire shapes (the frozen contract, Shapes 1/2/3)
  GateOpenSchema,
  GateOutcomeSchema,
  GateAnswerSchema,
  type GateOpen,
  type GateOutcome,
  type GateAnswer,
  // Enum + option
  GateTypeSchema,
  GateOptionSchema,
  type GateType,
  type GateOption,
  // gateKey/gateId derivation
  deriveGateKey,
  deriveGateId,
} from './schema.js';

import { GateTypeSchema } from './schema.js';

/** The 8 gate-type values as a readonly tuple (single source: GateTypeSchema). */
export const GATE_TYPES = GateTypeSchema.options;

export {
  IssueRefSchema,
  issueRefToString,
  type IssueRef,
} from './schemas.js';

export {
  ArtifactReviewKindSchema,
  ARTIFACT_REVIEW_KINDS,
  type ArtifactReviewKind,
} from './types.js';

export {
  deriveClarificationGeneration,
  deriveArtifactReviewGeneration,
  deriveImplementationReviewGeneration,
  deriveManualValidationGeneration,
  deriveEscalationGeneration,
  derivePhaseQueueGeneration,
  deriveFilingGeneration,
  deriveScopeDrainedGeneration,
  type ClarificationGenerationInput,
  type ArtifactReviewGenerationInput,
  type ImplementationReviewGenerationInput,
  type ManualValidationGenerationInput,
  type EscalationGenerationInput,
  type PhaseQueueGenerationInput,
  type FilingGenerationInput,
  type ScopeDrainedGenerationInput,
} from './generation.js';

export {
  VALID_FIXTURES,
  MALFORMED_FIXTURES,
  VALID_ANSWER_FIXTURES,
  VALID_ACK_FIXTURES,
} from './fixtures.js';

export {
  gateOpenFixture,
  gateOutcomeFixture,
  answerLineFixture,
  DEFAULT_WIRE_SCOPE,
  DEFAULT_WIRE_EPIC_REF,
  type WireScope,
  type GateOpenFixtureOverrides,
  type GateOutcomeFixtureOverrides,
  type AnswerLineFixtureOverrides,
} from './wire-fixtures.js';
