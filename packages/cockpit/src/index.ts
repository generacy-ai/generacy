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

// Wire contracts — the frozen cockpit remote-gate contract (Shapes 1/2/3).
// See tetrad-development/docs/cockpit-remote-gates-plan.md § "Wire contracts".
// The single source is packages/cockpit/src/gates/schema.ts.
// NB: gates' object `IssueRef` type collides with resolver's `IssueRef`
// (resolver = { owner, repo, issueNumber }; gates = { owner, repo, number }).
// We re-export the gates version as `GateIssueRef`. `IssueRefSchema` is unique so
// it stays unaliased. The wire shapes carry issueRef/epicRef as flat strings.
export {
  // Wire shapes (Shapes 1/2/3)
  GateOpenSchema,
  GateOutcomeSchema,
  GateAnswerSchema,
  type GateOpen,
  type GateOutcome,
  type GateAnswer,
  // Enum + option
  GateTypeSchema,
  GATE_TYPES,
  GateOptionSchema,
  ArtifactReviewKindSchema,
  ARTIFACT_REVIEW_KINDS,
  type GateType,
  type ArtifactReviewKind,
  type GateOption,
  // Object ref helper (cluster-local; not a wire type)
  IssueRefSchema,
  issueRefToString,
  type IssueRef as GateIssueRef,
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
  // #1038 — canonical clarification-batch hash (input to deriveClarificationGeneration)
  computeClarificationAnswerSetHash,
  type ClarificationQuestion,
  type ComputeClarificationAnswerSetHashInput,
  // Fixtures
  VALID_FIXTURES,
  MALFORMED_FIXTURES,
  VALID_ANSWER_FIXTURES,
  VALID_ACK_FIXTURES,
  CLARIFICATION_ANSWER_SET_FIXTURES,
  type ClarificationAnswerSetFixture,
  // Wire-frame fixture builders (#1024 integration harness)
  gateOpenFixture,
  gateOutcomeFixture,
  answerLineFixture,
  DEFAULT_WIRE_SCOPE,
  DEFAULT_WIRE_EPIC_REF,
  type WireScope,
  type GateOpenFixtureOverrides,
  type GateOutcomeFixtureOverrides,
  type AnswerLineFixtureOverrides,
} from './gates/index.js';
