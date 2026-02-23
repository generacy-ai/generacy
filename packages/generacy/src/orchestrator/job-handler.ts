/**
 * Job handler.
 * Handles job polling, execution, and result reporting.
 */
import { existsSync, readdirSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { execSync } from 'node:child_process';
import {
  loadWorkflowFromString,
  loadWorkflowWithExtends,
  prepareWorkflow,
  WorkflowExecutor,
  getActionHandlerByType,
  HumancyReviewAction,
  createGitHubClient,
  registerWorkflow,
  resolveRegisteredWorkflow,
  type WorkflowResolver,
  type HumanDecisionHandler,
  type ExecutionResult,
  type Logger,
  type WorkflowDefinition,
  type PhaseResult,
} from '@generacy-ai/workflow-engine';
import type { OrchestratorClient } from './client.js';
import type { Job, JobResult, JobEventType } from './types.js';
import { AsyncEventQueue } from './async-event-queue.js';

/**
 * Mapping from YAML phase names to completed:* label suffixes.
 * When a phase completes, we add `completed:{suffix}` to the issue.
 * When resolving startPhase on requeue, we check for these labels to skip phases.
 */
const PHASE_TO_LABEL_SUFFIX: Record<string, string> = {
  // setup is intentionally excluded — it always runs (handles branch checkout)
  specification: 'specify',
  clarification: 'clarify',
  planning: 'plan',
  'task-generation': 'tasks',
  implementation: 'implement',
  verification: 'validate',
};

/**
 * Ordered list of YAML phase names for resolving which phases to skip.
 * setup is excluded — it must always run.
 */
const PHASE_ORDER = [
  'specification',
  'clarification',
  'planning',
  'task-generation',
  'implementation',
  'verification',
];

/**
 * Phase gates: phases that should pause the workflow and wait for developer input.
 * Maps YAML phase name → waiting-for label to add when the gate is hit.
 */
const PHASE_GATES: Record<string, string> = {
  clarification: 'waiting-for:clarification',
};

/**
 * Event types to forward from the workflow executor to the orchestrator.
 * Lifecycle events (phase/step) needed for real-time monitoring (#175).
 * Log events for stdout/stderr streaming. Action-level events are too granular.
 */
const FORWARD_EVENT_TYPES = new Set<string>([
  'phase:start',
  'phase:complete',
  'step:start',
  'step:complete',
  'step:output',
  'log:append',
]);

/**
 * Register built-in workflow files from the generacy package's .generacy/ directory.
 * This is a temporary bridge until plugins (e.g., agency-plugin-spec-kit) bundle
 * and register their own workflows (see agency#244).
 *
 * Uses a lazy-init guard so registration only happens once, following the same
 * pattern as ensureActionsRegistered() in the workflow executor.
 */
let builtinWorkflowsRegistered = false;
function registerBuiltinWorkflows(): void {
  if (builtinWorkflowsRegistered) return;
  builtinWorkflowsRegistered = true;

  // Resolve the .generacy/ directory relative to this source file's package root.
  // From src/orchestrator/ (or dist/orchestrator/), go up to the monorepo root.
  const workflowDir = resolve(import.meta.dirname, '..', '..', '..', '..', '.generacy');

  if (!existsSync(workflowDir)) return;

  try {
    const entries = readdirSync(workflowDir);
    for (const entry of entries) {
      if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
      const name = entry.replace(/\.ya?ml$/, '');
      const filePath = resolve(workflowDir, entry);
      try {
        registerWorkflow(name, filePath);
      } catch {
        // registerWorkflow throws if file doesn't exist; skip silently
      }
    }
  } catch {
    // Directory not readable; skip silently
  }
}

/**
 * Job handler options
 */
export interface JobHandlerOptions {
  /** Orchestrator client */
  client: OrchestratorClient;

  /** Worker ID */
  workerId: string;

  /** Poll interval in milliseconds */
  pollInterval?: number;

  /** Logger instance */
  logger: Logger;

  /** Working directory for job execution */
  workdir?: string;

  /** Worker capabilities for job matching */
  capabilities?: string[];

  /** Callback when job starts */
  onJobStart?: (job: Job) => void;

  /** Callback when job completes */
  onJobComplete?: (job: Job, result: JobResult) => void;

  /** Callback for errors */
  onError?: (error: Error, job?: Job) => void;

  /** Human decision handler for real human-in-the-loop review */
  humanDecisionHandler?: HumanDecisionHandler;
}

/**
 * Handles job polling and execution
 */
export class JobHandler {
  private readonly client: OrchestratorClient;
  private readonly workerId: string;
  private readonly pollInterval: number;
  private readonly logger: Logger;
  private readonly workdir: string;
  private readonly capabilities: string[];
  private readonly onJobStart?: (job: Job) => void;
  private readonly onJobComplete?: (job: Job, result: JobResult) => void;
  private readonly onError?: (error: Error, job?: Job) => void;

  private pollTimer: NodeJS.Timeout | null = null;
  private currentJob: Job | null = null;
  private abortController: AbortController | null = null;
  private isRunning = false;
  private shouldStop = false;
  private readonly humanDecisionHandler?: HumanDecisionHandler;

  constructor(options: JobHandlerOptions) {
    registerBuiltinWorkflows();

    this.client = options.client;
    this.workerId = options.workerId;
    this.pollInterval = options.pollInterval ?? 5000;
    this.logger = options.logger;
    this.workdir = options.workdir ?? process.cwd();
    this.capabilities = options.capabilities ?? [];
    this.onJobStart = options.onJobStart;
    this.onJobComplete = options.onJobComplete;
    this.onError = options.onError;
    this.humanDecisionHandler = options.humanDecisionHandler;
  }

  /**
   * Start the job polling loop
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.shouldStop = false;
    this.poll();
  }

  /**
   * Stop the job polling loop
   */
  stop(): void {
    this.shouldStop = true;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    this.isRunning = false;
  }

  /**
   * Cancel the current job
   */
  cancelCurrentJob(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Get the currently executing job
   */
  getCurrentJob(): Job | null {
    return this.currentJob;
  }

  /**
   * Check if currently executing a job
   */
  isBusy(): boolean {
    return this.currentJob !== null;
  }

  /**
   * Poll for and process jobs
   */
  private async poll(): Promise<void> {
    if (this.shouldStop || this.currentJob) {
      return;
    }

    try {
      const response = await this.client.pollForJob(this.workerId, this.capabilities);

      if (response.job) {
        await this.executeJob(response.job);
      }

      // Schedule next poll
      if (!this.shouldStop && this.isRunning) {
        const delay = response.retryAfter ?? this.pollInterval;
        this.pollTimer = setTimeout(() => this.poll(), delay);
      }
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));

      // Continue polling after error with backoff
      if (!this.shouldStop && this.isRunning) {
        this.pollTimer = setTimeout(() => this.poll(), this.pollInterval * 2);
      }
    }
  }

  /**
   * Execute a job
   */
  private async executeJob(job: Job): Promise<void> {
    this.currentJob = job;
    this.abortController = new AbortController();
    const startTime = Date.now();
    const jobWorkdir = this.resolveJobWorkdir(job);

    // Record the current branch so we can restore it after the job
    let originalBranch: string | undefined;
    try {
      originalBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: jobWorkdir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim() || undefined;
    } catch {
      // Not a git repo or git not available - skip branch tracking
    }

    this.logger.info(`Starting job: ${job.id} (${job.name})`);
    this.onJobStart?.(job);

    // Set up event forwarding to orchestrator for real-time monitoring
    const eventQueue = new AsyncEventQueue(async (jobId, event) => {
      await this.client.publishEvent(jobId, event as {
        type: JobEventType;
        data: Record<string, unknown>;
        timestamp?: number;
      });
    });

    try {
      // Update job status to running
      await this.client.updateJobStatus(job.id, 'running', {
        startedAt: new Date().toISOString(),
      });

      // Load workflow
      let definition;
      if (typeof job.workflow === 'string') {
        // Could be a path or YAML content
        if (job.workflow.includes('\n') || job.workflow.startsWith('name:')) {
          definition = await loadWorkflowFromString(job.workflow);
        } else {
          const resolvedPath = this.resolveWorkflowPath(job.workflow, jobWorkdir);
          const resolver: WorkflowResolver = (name, excludePath) =>
            this.resolveWorkflowPath(name, jobWorkdir, excludePath);
          definition = await loadWorkflowWithExtends(resolvedPath, resolver);
        }
      } else {
        // Already a workflow object
        definition = job.workflow;
      }

      const workflow = prepareWorkflow(definition as WorkflowDefinition, job.inputs);

      // Remove already-completed phases (but never remove setup — it handles branch checkout)
      const completedPhases = await this.resolveCompletedPhases(job);
      if (completedPhases.size > 0) {
        this.logger.info(`Skipping completed phases: ${[...completedPhases].join(', ')}`);
        workflow.phases = workflow.phases.filter(
          p => !completedPhases.has(p.name)
        );
      }

      // Create executor (this also registers builtin actions)
      const executor = new WorkflowExecutor({
        logger: this.logger,
      });

      // Inject human decision handler AFTER executor creation, since the executor's
      // ensureActionsRegistered() may re-register action handlers
      if (this.humanDecisionHandler) {
        const reviewAction = getActionHandlerByType('humancy.request_review');
        if (reviewAction) {
          (reviewAction as HumancyReviewAction).setHumanHandler(this.humanDecisionHandler);
        }
      }

      // Listen for phase completions: add labels and handle gates
      const owner = job.inputs?.owner as string | undefined;
      const repo = job.inputs?.repo as string | undefined;
      const issueNumber = job.inputs?.issue_number as number | undefined;
      let shouldPauseForGate = false;
      let gatedPhaseName: string | undefined;
      const phasesWithFailedSteps = new Set<string>();

      executor.addEventListener((event) => {
        // Forward matching events to orchestrator
        if (FORWARD_EVENT_TYPES.has(event.type)) {
          eventQueue.push(job.id, {
            type: event.type,
            timestamp: event.timestamp,
            data: {
              phaseName: event.phaseName,
              stepName: event.stepName,
              message: event.message,
              ...(event.data as Record<string, unknown> ?? {}),
            },
          });
        }

        // Track step failures so we can label phases accurately
        if (event.type === 'step:error' && event.phaseName) {
          phasesWithFailedSteps.add(event.phaseName);
        }

        if (!owner || !repo || !issueNumber) return;
        if (event.type !== 'phase:complete' || !event.phaseName) return;

        const gateLabel = PHASE_GATES[event.phaseName];
        if (gateLabel) {
          // Check if the gated phase posted questions (needs developer input)
          const stepOutput = executor.getExecutionContext()?.getStepOutput('clarify');
          const parsed = stepOutput?.parsed as Record<string, unknown> | null;
          const postedQuestions = parsed?.posted_to_issue === true
            && (parsed?.questions_count as number) > 0;

          if (postedQuestions) {
            shouldPauseForGate = true;
            gatedPhaseName = event.phaseName;
            executor.cancel(); // stops before next phase starts
            return; // don't add completed label for gated phase
          }
        }

        // Add completed:* or failed:* label based on whether steps had errors
        const hasFailed = phasesWithFailedSteps.has(event.phaseName);
        void this.addPhaseLabel(owner, repo, issueNumber, event.phaseName, !hasFailed);
      });

      // Execute workflow
      const result = await executor.execute(
        workflow,
        {
          mode: 'normal',
          cwd: jobWorkdir,
          env: process.env as Record<string, string>,
        },
        job.inputs
      );

      // Handle gate pause: add waiting label and mark agent as paused
      if (shouldPauseForGate && gatedPhaseName && owner && repo && issueNumber) {
        const gateLabel = PHASE_GATES[gatedPhaseName]!;
        try {
          const github = createGitHubClient();
          await github.addLabels(owner, repo, issueNumber, [gateLabel, 'agent:paused']);
          try {
            await github.removeLabels(owner, repo, issueNumber, ['agent:in-progress']);
          } catch { /* may not exist */ }
          this.logger.info(`Paused at gate: ${gatedPhaseName}, added ${gateLabel}`);
        } catch (error) {
          this.logger.warn(`Failed to add gate label: ${error}`);
        }
      }

      // Build job result (treat gate-pause cancellation as success)
      const jobResult = this.buildJobResult(job, result, startTime, shouldPauseForGate);

      // Report result
      await this.client.reportJobResult(jobResult);
      this.logger.info(`Job completed: ${job.id} (${jobResult.status})`);
      this.onJobComplete?.(job, jobResult);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      this.logger.error(`Job failed: ${job.id} - ${errorMessage}`);
      this.onError?.(error instanceof Error ? error : new Error(errorMessage), job);

      // Report failure
      const failureResult: JobResult = {
        jobId: job.id,
        status: this.abortController?.signal.aborted ? 'cancelled' : 'failed',
        error: errorMessage,
        errorStack,
        duration: Date.now() - startTime,
      };

      try {
        await this.client.reportJobResult(failureResult);
      } catch (reportError) {
        this.logger.error(`Failed to report job result: ${reportError}`);
      }

      this.onJobComplete?.(job, failureResult);
    } finally {
      // Flush any remaining queued events before cleanup
      await eventQueue.flush();

      // Restore the original branch so the repo is clean for the next job
      if (originalBranch) {
        try {
          const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: jobWorkdir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          if (currentBranch !== originalBranch) {
            this.logger.info(`Restoring branch: ${originalBranch}`);
            execSync(`git checkout --force ${originalBranch}`, {
              cwd: jobWorkdir, stdio: ['pipe', 'pipe', 'pipe'],
            });
          }
        } catch (restoreError) {
          this.logger.warn(`Failed to restore branch ${originalBranch}: ${restoreError}`);
        }
      }

      this.currentJob = null;
      this.abortController = null;

      // Resume polling
      if (!this.shouldStop && this.isRunning) {
        this.pollTimer = setTimeout(() => this.poll(), this.pollInterval);
      }
    }
  }

  /**
   * Resolve the working directory for a job.
   * Uses MONITORED_REPOS env var to map owner/repo to local workspace paths.
   * Falls back to job.workdir, then this.workdir.
   */
  private resolveJobWorkdir(job: Job): string {
    if (job.workdir) return job.workdir;

    const owner = job.inputs?.owner as string | undefined;
    const repo = job.inputs?.repo as string | undefined;
    if (owner && repo) {
      const fullName = `${owner}/${repo}`;
      const monitoredRepos = process.env['MONITORED_REPOS'] ?? '';
      const repos = monitoredRepos.split(',').map(r => r.trim()).filter(Boolean);

      for (const entry of repos) {
        if (entry === fullName) {
          // Derive workspace path from the repo name portion
          const repoName = entry.split('/')[1];
          if (repoName) {
            const repoWorkdir = `/workspaces/${repoName}`;
            if (existsSync(repoWorkdir)) {
              this.logger.info(`Using repo workdir: ${repoWorkdir} (from MONITORED_REPOS)`);
              return repoWorkdir;
            }
          }
        }
      }
    }

    return this.workdir;
  }

  /**
   * Resolve a workflow name or path to an absolute file path.
   * Searches: absolute path, relative to workdir, .generacy/ directory, plugin registry.
   *
   * @param workflow - Workflow name or path to resolve
   * @param jobWorkdir - Job working directory for relative resolution
   * @param excludePath - Optional resolved path to skip (used by extends to avoid self-resolution)
   */
  private resolveWorkflowPath(workflow: string, jobWorkdir?: string, excludePath?: string): string {
    // 1. Absolute path (if exists and not excluded)
    if (isAbsolute(workflow) && existsSync(workflow) && resolve(workflow) !== excludePath) {
      return workflow;
    }

    const searchDir = jobWorkdir ?? this.workdir;

    // 2. Relative to workdir
    const direct = resolve(searchDir, workflow);
    if (existsSync(direct) && resolve(direct) !== excludePath) return direct;

    // 3. .generacy/ in workdir (repo-local override — highest priority)
    for (const ext of ['', '.yaml', '.yml']) {
      const candidate = resolve(searchDir, '.generacy', `${workflow}${ext}`);
      if (existsSync(candidate) && resolve(candidate) !== excludePath) return candidate;
    }

    // 4. Plugin-provided workflows (WorkflowRegistry)
    const registered = resolveRegisteredWorkflow(workflow);
    if (registered && registered !== excludePath) return registered;

    // Fallback: return original string (will produce a clear "file not found" error)
    return workflow;
  }

  /**
   * Resolve which phases have already been attempted based on issue labels.
   * Recognises both `completed:*` and `failed:*` labels so that phases are
   * not re-run on retry (failed verification still means the phase executed).
   * Returns a set of YAML phase names to skip. Setup is never included.
   */
  private async resolveCompletedPhases(job: Job): Promise<Set<string>> {
    const owner = job.inputs?.owner as string | undefined;
    const repo = job.inputs?.repo as string | undefined;
    const issueNumber = job.inputs?.issue_number as number | undefined;

    if (!owner || !repo || !issueNumber) {
      return new Set();
    }

    try {
      const github = createGitHubClient();
      const issue = await github.getIssue(owner, repo, issueNumber);
      const labelNames = issue.labels.map(l =>
        typeof l === 'string' ? l : l.name
      );

      // Find completed:* and failed:* labels (both indicate the phase has run)
      const attemptedSuffixes = new Set(
        labelNames
          .filter(n => n.startsWith('completed:') || n.startsWith('failed:'))
          .map(n => n.replace(/^(completed|failed):/, ''))
      );

      if (attemptedSuffixes.size === 0) {
        return new Set();
      }

      this.logger.info(`Found phase labels: ${[...attemptedSuffixes].join(', ')}`);

      // Map label suffixes back to YAML phase names
      const completed = new Set<string>();
      for (const phaseName of PHASE_ORDER) {
        const suffix = PHASE_TO_LABEL_SUFFIX[phaseName];
        if (suffix && attemptedSuffixes.has(suffix)) {
          completed.add(phaseName);
        }
      }

      return completed;
    } catch (error) {
      this.logger.warn(`Failed to resolve completed phases from labels: ${error}`);
      return new Set();
    }
  }

  /**
   * Add a completed:* or failed:* label to the issue after a phase finishes.
   * Uses `completed:` prefix when the phase succeeded, `failed:` when any step errored.
   */
  private async addPhaseLabel(
    owner: string,
    repo: string,
    issueNumber: number,
    phaseName: string,
    success: boolean,
  ): Promise<void> {
    const suffix = PHASE_TO_LABEL_SUFFIX[phaseName];
    if (!suffix) return;

    const prefix = success ? 'completed' : 'failed';
    const label = `${prefix}:${suffix}`;
    try {
      const github = createGitHubClient();
      await github.addLabels(owner, repo, issueNumber, [label]);
      this.logger.info(`Added label ${label} to ${owner}/${repo}#${issueNumber}`);
    } catch (error) {
      this.logger.warn(`Failed to add label ${label}: ${error}`);
    }
  }

  /**
   * Build job result from execution result
   */
  private buildJobResult(job: Job, result: ExecutionResult, startTime: number, gatePaused?: boolean): JobResult {
    // Find the first error from failed phases/steps
    let errorMessage: string | undefined;
    const failedPhase = result.phaseResults.find((p: PhaseResult) => p.status === 'failed');
    if (failedPhase) {
      const failedStep = failedPhase.stepResults.find(s => s.status === 'failed');
      if (failedStep?.error) {
        errorMessage = failedStep.error;
      }
    }

    return {
      jobId: job.id,
      // Gate-paused cancellation is intentional — report as completed so the worker is freed
      status: gatePaused ? 'completed' :
              result.status === 'completed' ? 'completed' :
              result.status === 'cancelled' ? 'cancelled' : 'failed',
      error: errorMessage,
      duration: Date.now() - startTime,
      phases: result.phaseResults.map((phase: PhaseResult) => ({
        name: phase.phaseName,
        status: phase.status,
        duration: phase.duration ?? 0,
      })),
      steps: result.phaseResults.flatMap((phase: PhaseResult) =>
        phase.stepResults.map(step => ({
          name: step.stepName,
          status: step.status,
          duration: step.duration ?? 0,
          error: step.error,
        }))
      ),
    };
  }
}
