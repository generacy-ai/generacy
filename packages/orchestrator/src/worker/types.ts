import type { QueueItem } from '../types/index.js';
import type { GitHubClient } from '@generacy-ai/workflow-engine';

/**
 * Workflow phases in execution order
 */
export type WorkflowPhase = 'specify' | 'clarify' | 'plan' | 'tasks' | 'implement' | 'validate';

/**
 * Ordered sequence of all workflow phases (default for feature/bugfix workflows)
 */
export const PHASE_SEQUENCE: WorkflowPhase[] = [
  'specify', 'clarify', 'plan', 'tasks', 'implement', 'validate',
];

/**
 * Phase sequences keyed by workflow name.
 * Each workflow can define a subset of phases to execute.
 */
export const WORKFLOW_PHASE_SEQUENCES: Record<string, WorkflowPhase[]> = {
  'speckit-feature': PHASE_SEQUENCE,
  'speckit-bugfix': PHASE_SEQUENCE,
  'speckit-epic': ['specify', 'clarify', 'plan', 'tasks'],
};

/**
 * Get the phase sequence for a given workflow name.
 * Falls back to PHASE_SEQUENCE for unknown workflows.
 */
export function getPhaseSequence(workflowName: string): WorkflowPhase[] {
  return WORKFLOW_PHASE_SEQUENCES[workflowName] ?? PHASE_SEQUENCE;
}

/**
 * Map each phase to its Claude CLI slash command (null = no CLI command)
 */
export const PHASE_TO_COMMAND: Record<WorkflowPhase, string | null> = {
  specify: '/specify',
  clarify: '/clarify',
  plan: '/plan',
  tasks: '/tasks',
  implement: '/implement',
  validate: null,
};

/**
 * Stage types for issue comments
 */
export type StageType = 'specification' | 'planning' | 'implementation';

/**
 * Map each phase to the stage it belongs to
 */
export const PHASE_TO_STAGE: Record<WorkflowPhase, StageType> = {
  specify: 'specification',
  clarify: 'specification',
  plan: 'planning',
  tasks: 'planning',
  implement: 'implementation',
  validate: 'implementation',
};

/**
 * HTML markers used to identify stage comments on issues
 */
export const STAGE_MARKERS: Record<StageType, string> = {
  specification: '<!-- generacy-stage:specification -->',
  planning: '<!-- generacy-stage:planning -->',
  implementation: '<!-- generacy-stage:implementation -->',
};

/**
 * Gate definition for pausing workflow at review checkpoints
 */
export interface GateDefinition {
  /** Phase that triggers gate check */
  phase: WorkflowPhase;
  /** Label to add when gate is active */
  gateLabel: string;
  /** When to activate the gate */
  condition: 'always' | 'on-request' | 'on-questions' | 'on-failure';
}

/**
 * Partial result from the implement operation when an increment boundary is reached.
 * Communicated via the SPECKIT_IMPLEMENT_PARTIAL sentinel in CLI text output.
 */
export interface ImplementPartialResult {
  partial?: boolean;
  tasks_completed?: number;
  tasks_remaining?: number;
  tasks_total?: number;
}

/**
 * Result from executing a single phase
 */
export interface PhaseResult {
  /** Phase that was executed */
  phase: WorkflowPhase;
  /** Whether the phase completed successfully */
  success: boolean;
  /** CLI exit code (0 = success) */
  exitCode: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Captured output chunks */
  output: OutputChunk[];
  /** Claude CLI session ID (for resuming conversation in subsequent phases) */
  sessionId?: string;
  /** Whether a gate was hit (stops the loop) */
  gateHit?: {
    gateLabel: string;
    reason: string;
  };
  /** Error details if failed */
  error?: {
    message: string;
    stderr: string;
    phase: WorkflowPhase;
  };
  /** Partial implement result parsed from sentinel output (implement phase only) */
  implementResult?: ImplementPartialResult;
}

/**
 * A single chunk of parsed output from Claude CLI
 */
export interface OutputChunk {
  /** Event type from Claude CLI JSON output */
  type: 'init' | 'tool_use' | 'tool_result' | 'text' | 'complete' | 'error';
  /** Parsed JSON data */
  data: unknown;
  /** Metadata (e.g., filePath for tool_result) */
  metadata?: Record<string, string>;
  /** Timestamp */
  timestamp: string;
}

/**
 * Options for spawning a Claude CLI process
 */
export interface CliSpawnOptions {
  /** The speckit command prompt */
  prompt: string;
  /** Working directory (repo checkout) */
  cwd: string;
  /** Environment variables to pass */
  env: Record<string, string>;
  /** Timeout in milliseconds */
  timeoutMs: number;
  /** Abort signal for graceful shutdown */
  signal: AbortSignal;
  /** Session ID from a previous phase to resume (keeps MCP servers warm, carries context) */
  resumeSessionId?: string;
}

/**
 * Data for stage comment updates on issues
 */
export interface StageCommentData {
  /** Stage type */
  stage: StageType;
  /** Current status */
  status: 'in_progress' | 'complete' | 'error';
  /** Phase progress within the stage */
  phases: {
    phase: WorkflowPhase;
    status: 'pending' | 'in_progress' | 'complete' | 'error';
    startedAt?: string;
    completedAt?: string;
  }[];
  /** When the stage started */
  startedAt: string;
  /** When the stage completed */
  completedAt?: string;
  /** PR URL if available */
  prUrl?: string;
}

/**
 * Logger interface (pino-compatible subset)
 */
export interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Context passed through the worker during processing
 */
export interface WorkerContext {
  /** Worker ID from dispatcher (UUID) */
  workerId: string;
  /** Queue item being processed */
  item: QueueItem;
  /** Resolved starting phase */
  startPhase: WorkflowPhase;
  /** GitHub client for API operations */
  github: GitHubClient;
  /** Logger instance */
  logger: Logger;
  /** Abort signal for graceful shutdown */
  signal: AbortSignal;
  /** Repository checkout path */
  checkoutPath: string;
  /** Issue URL for prompts */
  issueUrl: string;
  /** Issue description (from metadata or GitHub fetch) */
  description: string;
  /** PR URL — set after draft PR is created, updated by PrManager */
  prUrl?: string;
}

/**
 * Factory for creating child processes (injectable for testing)
 */
export interface ProcessFactory {
  spawn(
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; signal?: AbortSignal },
  ): ChildProcessHandle;
}

/**
 * Handle to a spawned child process
 */
export interface ChildProcessHandle {
  /** Process stdout stream */
  stdout: NodeJS.ReadableStream | null;
  /** Process stderr stream */
  stderr: NodeJS.ReadableStream | null;
  /** Process PID */
  pid: number | undefined;
  /** Kill the process */
  kill(signal?: NodeJS.Signals): boolean;
  /** Promise that resolves with exit code when process exits */
  exitPromise: Promise<number | null>;
}
