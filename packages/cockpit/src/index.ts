// @generacy-ai/cockpit — public API surface.
// Internal modules (state/label-map) are NOT exported.

// State + classifier
export {
  COCKPIT_STATES,
  type CockpitState,
  type ClassifyResult,
} from './types.js';
export { classify } from './state/classifier.js';
export { TIER_RANK, WAITING_PIPELINE_ORDER } from './state/precedence.js';

// Config
export {
  CockpitConfigSchema,
  type CockpitConfig,
  type CockpitConfigSource,
  type LoadedCockpitConfig,
} from './config/schema.js';
export {
  loadCockpitConfig,
  type LoadCockpitConfigOptions,
} from './config/loader.js';

// Resolver (single-source epic discovery)
export { parseEpicBody } from './resolver/parse-epic-body.js';
export { resolveEpic } from './resolver/resolve.js';
export { matchPhaseHeading, firstToken } from './resolver/heading-match.js';
export { parseRef } from './resolver/ref-shapes.js';
export {
  LoudResolverError,
  type LoudResolverErrorCode,
} from './resolver/errors.js';
export type {
  IssueRef,
  ParsedPhase,
  ParsedEpicBody,
  ParseEpicBodyOptions,
  ResolvedEpic,
  ResolveEpicOptions,
} from './resolver/types.js';

// gh wrapper
export {
  GhCliWrapper,
  DIFF_BYTE_CAP,
  DIFF_TRUNCATION_MARKER,
  type GhWrapper,
  type GhCliWrapperOptions,
  type Issue,
  type CheckRunSummary,
  type ListIssuesOptions,
  type PullRequestSummary,
  type PullRequestRef,
  type PullRequestRefResolution,
  type LinkMethod,
  type PrCandidate,
  type PullRequestDetail,
  type PullRequestGraphqlDetail,
  type MergeResult,
  type DeleteHeadRefResult,
  type RequiredChecksResult,
  type CommandRunner,
  type IssueLabelsResult,
  type IssueStateResult,
  type IssueComment,
  type OpenPrForBranch,
} from './gh/wrapper.js';
export {
  nodeChildProcessRunner,
  type CommandRunnerOptions,
  type CommandResult,
} from './gh/command-runner.js';
export {
  createGhResponseCache,
  type GhCacheOptions,
  type GhResponseCache,
} from './gh/cache.js';
export {
  createRateLimitScheduler,
  type RateLimitSchedulerOptions,
  type RateLimitScheduler,
  type RateLimitProbeResult,
} from './gh/rate-limit-scheduler.js';

// Wire contracts — see specs/1020-part-cockpit-remote-gates/
// NB: gates' `IssueRef` type collides with resolver's `IssueRef` (different shapes:
// resolver = { owner, repo, issueNumber }; gates = { owner, repo, number }).
// We re-export the gates version as `GateIssueRef`. `IssueRefSchema` is unique so
// it stays unaliased.
export {
  // Schemas
  GateRecordSchema,
  GateAnswerSchema,
  GateOutcomeAckSchema,
  GateOptionSchema,
  IssueRefSchema,
  ActorSchema,
  // Enums
  GateTypeSchema,
  GATE_TYPES,
  ArtifactReviewKindSchema,
  ARTIFACT_REVIEW_KINDS,
  GateOutcomeSchema,
  GATE_OUTCOMES,
  // Types
  type GateType,
  type ArtifactReviewKind,
  type GateOutcome,
  type GateOption,
  type IssueRef as GateIssueRef,
  type Actor,
  type GateRecord,
  type GateAnswer,
  type GateOutcomeAck,
  // Derivation
  deriveGateKey,
  deriveGateId,
  deriveClarificationGeneration,
  deriveArtifactReviewGeneration,
  deriveImplementationReviewGeneration,
  deriveManualValidationGeneration,
  deriveEscalationGeneration,
  derivePhaseQueueGeneration,
  deriveFilingGeneration,
  deriveScopeDrainedGeneration,
  // Fixtures
  VALID_FIXTURES,
  MALFORMED_FIXTURES,
  VALID_ANSWER_FIXTURES,
  VALID_ACK_FIXTURES,
} from './gates/index.js';
