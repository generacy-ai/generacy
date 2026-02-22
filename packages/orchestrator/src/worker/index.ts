// Worker types
export {
  type WorkflowPhase,
  type StageType,
  type GateDefinition,
  type PhaseResult,
  type OutputChunk,
  type CliSpawnOptions,
  type StageCommentData,
  type WorkerContext,
  type ProcessFactory,
  type ChildProcessHandle,
  type Logger,
  PHASE_SEQUENCE,
  PHASE_TO_COMMAND,
  PHASE_TO_STAGE,
  STAGE_MARKERS,
} from './types.js';

// Worker config
export { WorkerConfigSchema, type WorkerConfig } from './config.js';

// Core components
export { PhaseResolver } from './phase-resolver.js';
export { LabelManager } from './label-manager.js';
export { StageCommentManager } from './stage-comment-manager.js';
export { GateChecker } from './gate-checker.js';
export { OutputCapture, type SSEEventEmitter } from './output-capture.js';

// Process management
export { CliSpawner } from './cli-spawner.js';
export { RepoCheckout } from './repo-checkout.js';

// Phase loop and assembly
export { PhaseLoop, type PhaseLoopDeps, type PhaseLoopResult } from './phase-loop.js';
export { ClaudeCliWorker, type ClaudeCliWorkerDeps } from './claude-cli-worker.js';

// Epic workflow handlers
export { EpicPostTasks, type EpicPostTasksResult } from './epic-post-tasks.js';
