// @generacy-ai/cockpit — public API surface.
// Internal modules (state/label-map, orchestrator/http, orchestrator/stub) are
// NOT exported.

// State + classifier
export { COCKPIT_STATES, type CockpitState, type ClassifyResult } from './types.js';
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

// Manifest
export {
  EpicManifestSchema,
  EpicEntrySchema,
  PhaseEntrySchema,
  type EpicManifest,
  type EpicEntry,
  type PhaseEntry,
} from './manifest/schema.js';
export {
  readManifest,
  writeManifest,
  appendChildIssue,
} from './manifest/io.js';
export {
  resolveEpicIssues,
  type ResolveEpicIssuesOptions,
} from './manifest/scoping.js';

// gh wrapper
export {
  GhCliWrapper,
  type GhWrapper,
  type Issue,
  type CheckRunSummary,
  type ListIssuesOptions,
  type PullRequestSummary,
  type CommandRunner,
} from './gh/wrapper.js';
export {
  nodeChildProcessRunner,
  type CommandRunnerOptions,
  type CommandResult,
} from './gh/command-runner.js';

// Orchestrator client
export {
  createOrchestratorClient,
  type OrchestratorClient,
  type CreateOrchestratorClientConfig,
  type HealthResult,
  type JobsResult,
  type WorkersResult,
  type JobSummary,
  type WorkerSummary,
  type UnavailableReason,
} from './orchestrator/client.js';
