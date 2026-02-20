/**
 * Job handler.
 * Handles job polling, execution, and result reporting.
 */
import { existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { execSync } from 'node:child_process';
import {
  loadWorkflowFromString,
  loadWorkflow,
  prepareWorkflow,
  WorkflowExecutor,
  getActionHandlerByType,
  HumancyReviewAction,
  createGitHubClient,
  type HumanDecisionHandler,
  type ExecutionResult,
  type Logger,
  type WorkflowDefinition,
  type PhaseResult,
} from '@generacy-ai/workflow-engine';
import type { OrchestratorClient } from './client.js';
import type { Job, JobResult } from './types.js';

/**
 * Mapping from YAML phase names to completed:* label suffixes.
 * When a phase completes, we add `completed:{suffix}` to the issue.
 * When resolving startPhase on requeue, we check for these labels to skip phases.
 */
const PHASE_TO_LABEL_SUFFIX: Record<string, string> = {
  setup: 'setup',
  specification: 'specify',
  clarification: 'clarify',
  planning: 'plan',
  'task-generation': 'tasks',
  implementation: 'implement',
  verification: 'validate',
};

/**
 * Ordered list of YAML phase names for resolving which phases to skip.
 */
const PHASE_ORDER = [
  'setup',
  'specification',
  'clarification',
  'planning',
  'task-generation',
  'implementation',
  'verification',
];

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
    const jobWorkdir = job.workdir ?? this.workdir;

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
          const resolvedPath = this.resolveWorkflowPath(job.workflow, job.workdir);
          definition = await loadWorkflow(resolvedPath);
        }
      } else {
        // Already a workflow object
        definition = job.workflow;
      }

      const workflow = prepareWorkflow(definition as WorkflowDefinition, job.inputs);

      // Resolve startPhase from issue labels (skip already-completed phases on requeue)
      const startPhase = await this.resolveStartPhase(job);
      if (startPhase) {
        this.logger.info(`Resuming workflow from phase: ${startPhase}`);
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

      // Listen for phase completions to add completed:* labels to the issue
      const owner = job.inputs?.owner as string | undefined;
      const repo = job.inputs?.repo as string | undefined;
      const issueNumber = job.inputs?.issue_number as number | undefined;

      if (owner && repo && issueNumber) {
        executor.addEventListener((event) => {
          if (event.type === 'phase:complete' && event.phaseName) {
            void this.addCompletedLabel(owner, repo, issueNumber, event.phaseName);
          }
        });
      }

      // Execute workflow
      const result = await executor.execute(
        workflow,
        {
          mode: 'normal',
          cwd: job.workdir ?? this.workdir,
          env: process.env as Record<string, string>,
          startPhase,
        },
        job.inputs
      );

      // Build job result
      const jobResult = this.buildJobResult(job, result, startTime);

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
   * Resolve a workflow name or path to an absolute file path.
   * Searches: absolute path, relative to workdir, .generacy/ directories.
   */
  private resolveWorkflowPath(workflow: string, jobWorkdir?: string): string {
    // If already absolute and exists, use directly
    if (isAbsolute(workflow) && existsSync(workflow)) {
      return workflow;
    }

    const searchDirs = [
      jobWorkdir ?? this.workdir,
      '/workspaces/tetrad-development',
    ];

    for (const dir of searchDirs) {
      // Try as-is relative to dir
      const direct = resolve(dir, workflow);
      if (existsSync(direct)) return direct;

      // Try in .generacy/ subdirectory
      for (const ext of ['', '.yaml', '.yml']) {
        const candidate = resolve(dir, '.generacy', `${workflow}${ext}`);
        if (existsSync(candidate)) return candidate;
      }
    }

    // Fallback: return original string (will produce a clear "file not found" error)
    return workflow;
  }

  /**
   * Resolve which phase to start from based on completed:* labels on the issue.
   * Returns the name of the first uncompleted phase, or undefined to start from the beginning.
   */
  private async resolveStartPhase(job: Job): Promise<string | undefined> {
    const owner = job.inputs?.owner as string | undefined;
    const repo = job.inputs?.repo as string | undefined;
    const issueNumber = job.inputs?.issue_number as number | undefined;

    if (!owner || !repo || !issueNumber) {
      return undefined;
    }

    try {
      const github = createGitHubClient();
      const issue = await github.getIssue(owner, repo, issueNumber);
      const labelNames = issue.labels.map(l =>
        typeof l === 'string' ? l : l.name
      );

      // Find completed:* labels
      const completedSuffixes = new Set(
        labelNames
          .filter(n => n.startsWith('completed:'))
          .map(n => n.slice('completed:'.length))
      );

      if (completedSuffixes.size === 0) {
        return undefined;
      }

      this.logger.info(`Found completed labels: ${[...completedSuffixes].join(', ')}`);

      // Walk through phase order and find the first non-completed phase
      for (const phaseName of PHASE_ORDER) {
        const suffix = PHASE_TO_LABEL_SUFFIX[phaseName];
        if (!suffix || !completedSuffixes.has(suffix)) {
          // This phase hasn't been completed — start here
          // But never skip setup (it's idempotent and fast)
          if (phaseName === 'setup') continue;
          this.logger.info(`Resolved startPhase: ${phaseName}`);
          return phaseName;
        }
      }

      // All phases completed — start from the beginning (shouldn't happen in practice)
      return undefined;
    } catch (error) {
      this.logger.warn(`Failed to resolve startPhase from labels: ${error}`);
      return undefined;
    }
  }

  /**
   * Add a completed:* label to the issue after a phase finishes successfully.
   */
  private async addCompletedLabel(
    owner: string,
    repo: string,
    issueNumber: number,
    phaseName: string,
  ): Promise<void> {
    const suffix = PHASE_TO_LABEL_SUFFIX[phaseName];
    if (!suffix) return;

    const label = `completed:${suffix}`;
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
  private buildJobResult(job: Job, result: ExecutionResult, startTime: number): JobResult {
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
      status: result.status === 'completed' ? 'completed' :
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
