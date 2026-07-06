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
  ResolvedEpic,
  ResolveEpicOptions,
} from './resolver/types.js';

// gh wrapper
export {
  GhCliWrapper,
  DIFF_BYTE_CAP,
  DIFF_TRUNCATION_MARKER,
  type GhWrapper,
  type Issue,
  type CheckRunSummary,
  type ListIssuesOptions,
  type PullRequestSummary,
  type PullRequestRef,
  type PullRequestDetail,
  type MergeResult,
  type RequiredChecksResult,
  type CommandRunner,
} from './gh/wrapper.js';
export {
  nodeChildProcessRunner,
  type CommandRunnerOptions,
  type CommandResult,
} from './gh/command-runner.js';
