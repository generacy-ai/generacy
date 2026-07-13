import type { QueueItem } from '../types/index.js';
import type { GitHubClient, LinkedPR } from '@generacy-ai/workflow-engine';

/**
 * Workflow phases in execution order
 */
export type WorkflowPhase = 'specify' | 'clarify' | 'plan' | 'tasks' | 'implement' | 'validate';

/**
 * Event types captured in the conversation JSONL log.
 */
export type JournalEventType = 'phase_start' | 'phase_complete' | 'tool_use' | 'tool_result' | 'error';

/**
 * A single entry in the conversation JSONL log file.
 * Optional fields are included when available and omitted when not.
 */
export interface JournalEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Workflow phase that produced this entry */
  phase: WorkflowPhase;
  /** Type of event */
  event_type: JournalEventType;
  /** Claude CLI session ID */
  session_id: string;
  /** Model name (e.g., "claude-sonnet-4-6") */
  model?: string;
  /** Input token count from complete event */
  tokens_in?: number;
  /** Output token count from complete event */
  tokens_out?: number;
  /** Tool name for tool_use/tool_result events */
  tool_name?: string;
  /** Tool call ID for pairing tool_use → tool_result */
  tool_call_id?: string;
  /** File paths touched by tool */
  file_paths?: string[];
  /** Tool execution duration in ms (on tool_result only) */
  duration_ms?: number;
  /** Error description (on error events only) */
  error_message?: string;
}

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
 * HTML-marker prefix used on failure-alert comments. Full marker shape:
 *   <!-- generacy:failure-alert:<stage>:<runId> -->
 * where <stage> is a StageType and <runId> is a UUID minted at
 * PhaseLoop.executeLoop entry.
 *
 * Future cockpit tooling MAY parse this prefix to discover alert history on
 * an issue. Format changes require a contract-file edit
 * (specs/865-found-during-cockpit-v1/contracts/failure-alert-comment.md).
 */
export const FAILURE_ALERT_MARKER_PREFIX = '<!-- generacy:failure-alert:';

/**
 * Gate definition for pausing workflow at review checkpoints
 */
export interface GateDefinition {
  /** Phase that triggers gate check */
  phase: WorkflowPhase;
  /** Label to add when gate is active */
  gateLabel: string;
  /** When to activate the gate */
  condition: 'always' | 'on-request' | 'on-questions' | 'on-failure' | 'on-sibling-review' | 'on-merge-conflict';
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
  /**
   * Raw stdout captured from the phase process, only populated by
   * `runValidatePhase` (#892 evidence pipeline). Undefined for CLI phases,
   * which surface output via `output: OutputChunk[]`.
   */
  capturedStdout?: string;
  /** Raw stderr captured from the phase process (validate + install paths). */
  capturedStderr?: string;
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
    /**
     * Merged stdout+stderr tail from the failed subprocess.
     * - Shell paths (`runValidatePhase`, `runPreValidateInstall`): populated from
     *   the ring buffer in `manageProcess` (bounded ~8 KiB, arrival-order
     *   best-effort per Q5→A).
     * - CLI paths (`spawnPhase`): empty string. Evidence is synthesized from
     *   `PhaseResult.output` (parsed `type: 'text'` chunks) at evidence-build
     *   time via `synthesizeOutputTail`.
     * - Synthesized results (no-progress guard, product-diff detection failure,
     *   empty-product-diff failure, unexpected-spawn catch): set by the caller
     *   to a controlled diagnostic string.
     */
    output: string;
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
  /** Sibling repository working directories (repo name → absolute path) */
  siblingWorkdirs?: Record<string, string>;
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
  /**
   * Rendered inside the comment when status === 'error' or during a merge-conflict pause.
   *
   * Discriminated union with two variants:
   * - #847/#890 command-exit variant: `{ command, exitDescriptor, outputTail }` — populated by
   *   phase-loop.ts at each `updateStageComment({ status: 'error' })` call site.
   * - #864 merge-conflict variant: `{ mergeConflict: { baseRef, conflictedPaths } }` — populated
   *   by the pre-phase base-merge hook when a merge conflict pauses the workflow.
   *
   * Consumed by StageCommentManager.renderStageComment which narrows on `.mergeConflict`
   * presence. Exactly one variant is populated per call; both being present is a
   * programmer bug and asserted (dev-mode).
   */
  errorEvidence?:
    | {
        /** The failing command string as it was passed to the spawner. */
        command: string;
        /** Resolved exit descriptor: `exit <N>`, `killed (SIGTERM) after <Nms>`, or `aborted` (FR-005, Q5→A). */
        exitDescriptor: string;
        /**
         * Bounded merged tail — stdout and stderr chunks in Node `data`-event
         * arrival order (best-effort per FR-004, Q5→A). Last 30 lines then 4 KiB
         * cap, truncation marker prepended when applicable. Literal
         * `(no output on either stream)` when both streams were empty. Never
         * renders as `(empty)` when either stream produced any output (FR-003).
         *
         * Populated by phase-loop.ts via `buildErrorEvidence`, which:
         * - For shell phases (validate, pre-validate): reads `result.error.output`
         *   (the merged ring-buffer tail from manageProcess) and passes through
         *   `boundOutputTail`.
         * - For CLI phases: synthesizes from `result.output`'s `type: 'text'`
         *   chunks via `synthesizeOutputTail` (also bounder-capped).
         */
        outputTail: string;
        /**
         * #915: Optional classifier reason — the human-readable message that
         * explains why a synthetic post-exit failure was raised (product-diff
         * guard, no-progress guard, spawn-error catch, product-diff-error
         * catch). Sourced from `result.error.message` when the
         * `buildErrorEvidence` caller passed an explicit `classifier` argument.
         *
         * Absent on process-failure paths (shell/CLI real non-zero exit) —
         * the outputTail already carries the diagnostic surface.
         *
         * Rendering: single-line reasons appear inline as `**Reason**: <r>`;
         * multi-line reasons appear as `**Reason**:` on its own line followed
         * by a fenced ```text``` block, capped at 1 KiB with a trailing `…`
         * marker. Backticks are ZWSP-escaped before render, matching outputTail.
         */
        reason?: string;
      }
    | {
        /** Base-sync merge conflict variant (#864). */
        mergeConflict: {
          /** The `origin/<base>` ref that was being merged. */
          baseRef: string;
          /** Paths reported by `git diff --name-only --diff-filter=U`. */
          conflictedPaths: string[];
          /**
           * #898 FR-011/FR-012 Ship 1: three-step manual remedy rendered into
           * the pause comment. Optional to preserve backwards compatibility
           * with pre-Ship-1 evidence blobs (queue admin views, cockpit status
           * reads from historical comments). Post-Ship-1 the phase-loop pause
           * site always populates this.
           */
          manualRemedy?: {
            /** 3 strings, template-substituted at build time. */
            steps: string[];
            /** Callout warning under the numbered list. */
            warning: string;
          };
        };
      };
}

/**
 * The #847/#890 command-exit variant of `StageCommentData.errorEvidence` —
 * `{ command, exitDescriptor, outputTail }`. The failure-alert path (#865) only
 * ever carries this variant; the #864 merge-conflict variant is rendered in
 * place by `StageCommentManager.appendMergeConflictBlock`, never via an alert.
 */
export type CommandExitEvidence = Extract<
  NonNullable<StageCommentData['errorEvidence']>,
  { command: string }
>;

/**
 * Input to StageCommentManager.postFailureAlert. Composed by phase-loop.ts at
 * each of the terminal-error sites (pre-validate install failure, unexpected
 * spawn error, post-phase failure, product-diff failures, no-progress guard)
 * and passed as-is to the manager.
 *
 * `runId` is minted once per PhaseLoop.executeLoop invocation via
 * crypto.randomUUID(). See specs/865-found-during-cockpit-v1/contracts/failure-alert-comment.md.
 */
export interface FailureAlertData {
  /**
   * The stage/kind the failure belongs to.
   *
   * - `StageType` (specification | planning | implementation) — phase-level
   *   failures rendered inside the stage comment marker.
   * - `'label-op'` (#889) — GitHub label-operation exhaustion terminal failure,
   *   emitted by `WorkerDispatcher` on `WorkerResult.status === 'failed-terminal'`.
   *   Uses its own marker suffix and a different summary line.
   */
  stage: StageType | 'label-op';
  /** Stable per-runPhaseLoop-invocation UUID (dedup key inside the marker). */
  runId: string;
  /**
   * The failing phase name (used in the summary line). For `stage === 'label-op'`
   * this carries the `TerminalLabelOpSite` string ("gate-hit", "phase-start", …)
   * rather than a `WorkflowPhase` — the site is what surfaces in the alert body.
   */
  phase: WorkflowPhase | string;
  /**
   * Verbatim reuse of buildErrorEvidence output. NO re-derivation.
   */
  evidence: CommandExitEvidence;
  /**
   * Only populated when `stage === 'label-op'` (#889). The `labelOp` field is
   * copied verbatim from `WorkerResult.failureMetadata.labelOp`.
   */
  labelOp?: string;
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
 * Callback for emitting job lifecycle events through the relay WebSocket.
 * Fire-and-forget — implementations must not throw.
 */
export type JobEventEmitter = (event: string, data: Record<string, unknown>) => void;

/**
 * Context passed through the worker during processing
 */
export interface WorkerContext {
  /** Worker ID from dispatcher (UUID) */
  workerId: string;
  /** Job UUID generated at dequeue time for lifecycle event correlation */
  jobId: string;
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
  /** Feature branch name (e.g. `864-found-during-cockpit-v1`) — un-prefixed. */
  branch?: string;
  /** Issue URL for prompts */
  issueUrl: string;
  /** Issue description (from metadata or GitHub fetch) */
  description: string;
  /** PR URL — set after draft PR is created, updated by PrManager */
  prUrl?: string;
  /** Sibling repository working directories (repo name → absolute path) */
  siblingWorkdirs?: Record<string, string>;
  /** PRs opened in sibling repos during cross-repo fan-out (from WorkflowState) */
  linkedPRs?: LinkedPR[];
  /**
   * Why the worker was resumed (#892). Set by the resume path when the
   * base-advance monitor enqueued the re-run. Gates ValidateFixHandler
   * invocation in PhaseLoop's validate `catch` block (D7 ordering invariant).
   */
  resumeReason?: 'base-advance';
  /** Base branch SHA that triggered the resume (#892). Surfaces in logs. */
  baseSha?: string;
}

/**
 * Factory for creating child processes (injectable for testing)
 */
export interface ProcessFactory {
  spawn(
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; signal?: AbortSignal; uid?: number; gid?: number; detached?: boolean },
  ): ChildProcessHandle;
}

/**
 * Handle to a spawned child process
 */
/**
 * Result from commitPushAndEnsurePr() — whether the phase produced changes and the PR URL.
 */
export interface CommitResult {
  /** PR URL if one was created or already exists */
  prUrl?: string;
  /** Whether the phase produced any git changes */
  hasChanges: boolean;
}

/**
 * Context provided to phase:after handlers.
 * Includes the full WorkerContext plus the completed phase name and its commit result.
 */
export interface PhaseAfterContext extends WorkerContext {
  /** The phase that just completed */
  phase: WorkflowPhase;
  /** Result from commitPushAndEnsurePr() for this phase */
  commitResult: CommitResult;
}

/**
 * Async function that runs after a phase completes (post-commit, pre-gate).
 * Throwing stops subsequent handlers (fail-fast) and blocks the phase.
 */
export type PhaseAfterHandler = (context: PhaseAfterContext) => Promise<void>;

export interface ChildProcessHandle {
  /** Process stdin stream (null when stdio[0] is 'ignore') */
  stdin: NodeJS.WritableStream | null;
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
