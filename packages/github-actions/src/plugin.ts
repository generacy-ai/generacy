import type {
  Pipeline,
  PipelineRun,
  PipelineStatus,
  TriggerOptions,
  IssueTracker,
} from '@generacy-ai/latency';
import { AbstractCICDPlugin } from '@generacy-ai/latency-plugin-ci-cd';
import type { GitHubActionsConfig } from './types/config.js';
import type { WorkflowRun, TriggerWorkflowParams, Workflow } from './types/workflows.js';
import type { Job } from './types/jobs.js';
import type { Artifact } from './types/artifacts.js';
import type { CheckRun, CreateCheckRunParams, UpdateCheckRunParams } from './types/check-runs.js';
import type { PollingConfig, PollingResult, PollingHandle } from './polling/types.js';
import type { EventBus } from './events/types.js';

import { GitHubClient, createClient } from './client.js';
import { parseConfig } from './types/config.js';
import { triggerWorkflow, triggerWorkflowDispatch, getWorkflowId, listWorkflows } from './operations/workflows.js';
import {
  getWorkflowRun,
  listWorkflowRuns,
  cancelWorkflowRun,
  rerunWorkflowRun,
  rerunFailedJobs,
} from './operations/runs.js';
import { getJobs, getJob, getJobLogs, getFailedJobs } from './operations/jobs.js';
import {
  listArtifacts,
  getArtifact,
  downloadArtifact,
  deleteArtifact,
  listRepoArtifacts,
} from './operations/artifacts.js';
import {
  createCheckRun,
  updateCheckRun,
  getCheckRun,
  listCheckRuns,
  listCheckRunsForSuite,
} from './operations/check-runs.js';
import { StatusPoller, createStatusPoller, pollUntilComplete, waitForRun } from './polling/status-poller.js';
import { WorkflowEventEmitter, createEventEmitter } from './events/emitter.js';

/**
 * Plugin manifest declaration
 */
export const PLUGIN_MANIFEST = {
  name: '@generacy-ai/generacy-plugin-github-actions',
  version: '0.1.0',
  provides: ['GitHubActions', 'CICDPipeline'],
  requires: [
    { facet: 'EventBus', optional: false },
  ],
  optionalRequires: [
    { facet: 'IssueTracker', optional: true },
  ],
} as const;

/**
 * GitHubActionsPlugin - Main plugin class
 *
 * Extends AbstractCICDPlugin to provide the standard CICDPipeline interface
 * (triggerPipeline, getPipelineStatus, cancelPipeline, listPipelines) while
 * also exposing GitHub Actions-specific functionality.
 */
export class GitHubActionsPlugin extends AbstractCICDPlugin {
  private readonly client: GitHubClient;
  private readonly config: GitHubActionsConfig;
  private readonly eventEmitter: WorkflowEventEmitter | null;
  private issueTracker: IssueTracker | null = null;

  constructor(config: GitHubActionsConfig, eventBus?: EventBus) {
    super();
    this.config = parseConfig(config);
    this.client = createClient(this.config);
    this.eventEmitter = eventBus ? createEventEmitter(eventBus) : null;
  }

  /**
   * Set the issue tracker facet for optional integration
   */
  setIssueTracker(tracker: IssueTracker): void {
    this.issueTracker = tracker;
  }

  // ==========================================================================
  // AbstractCICDPlugin abstract method implementations
  // ==========================================================================

  /**
   * Trigger a pipeline run (implements abstract method).
   *
   * Maps to GitHub Actions workflow dispatch.
   */
  protected async doTrigger(pipelineId: string, options?: TriggerOptions): Promise<PipelineRun> {
    const ref = options?.branch ?? 'main';
    const run = await triggerWorkflowDispatch(
      this.client,
      pipelineId,
      ref,
      options?.parameters
    );
    return this.mapWorkflowRunToPipelineRun(run);
  }

  /**
   * Get pipeline run status (implements abstract method).
   *
   * Maps to getWorkflowRun.
   */
  protected async doGetStatus(runId: string): Promise<PipelineRun> {
    const run = await getWorkflowRun(this.client, parseInt(runId, 10));
    return this.mapWorkflowRunToPipelineRun(run);
  }

  /**
   * Cancel a pipeline run (implements abstract method).
   *
   * Maps to cancelWorkflowRun.
   */
  protected async doCancel(runId: string): Promise<void> {
    await cancelWorkflowRun(this.client, parseInt(runId, 10));
  }

  /**
   * List available pipelines (implements abstract method).
   *
   * Maps to listWorkflows.
   */
  protected async doListPipelines(): Promise<Pipeline[]> {
    const workflows = await listWorkflows(this.client);
    return workflows.map((workflow) => this.mapWorkflowToPipeline(workflow));
  }

  // ==========================================================================
  // GitHub Actions-specific public API (for backwards compatibility)
  // ==========================================================================

  /**
   * Trigger a workflow by filename or ID
   */
  async triggerWorkflow(params: TriggerWorkflowParams): Promise<WorkflowRun> {
    return triggerWorkflow(this.client, params);
  }

  /**
   * Trigger a workflow dispatch event
   */
  async triggerWorkflowDispatch(
    workflow: string,
    ref: string,
    inputs?: Record<string, string>
  ): Promise<WorkflowRun> {
    return triggerWorkflowDispatch(this.client, workflow, ref, inputs);
  }

  /**
   * Get workflow ID by filename
   */
  async getWorkflowId(filename: string): Promise<number> {
    return getWorkflowId(this.client, filename);
  }

  // ============================================
  // Run Monitoring & Control
  // ============================================

  /**
   * Get a workflow run by ID
   */
  async getWorkflowRun(runId: number): Promise<WorkflowRun> {
    return getWorkflowRun(this.client, runId);
  }

  /**
   * List workflow runs for a workflow
   */
  async listWorkflowRuns(
    workflow: string | number,
    options?: {
      branch?: string;
      event?: string;
      status?: 'completed' | 'action_required' | 'cancelled' | 'failure' | 'neutral' | 'skipped' | 'stale' | 'success' | 'timed_out' | 'in_progress' | 'queued' | 'requested' | 'waiting' | 'pending';
      per_page?: number;
      page?: number;
    }
  ): Promise<WorkflowRun[]> {
    return listWorkflowRuns(this.client, workflow, options);
  }

  /**
   * Cancel a workflow run
   */
  async cancelWorkflowRun(runId: number): Promise<void> {
    return cancelWorkflowRun(this.client, runId);
  }

  /**
   * Re-run a workflow
   */
  async rerunWorkflowRun(runId: number): Promise<WorkflowRun> {
    return rerunWorkflowRun(this.client, runId);
  }

  /**
   * Re-run failed jobs in a workflow
   */
  async rerunFailedJobs(runId: number): Promise<WorkflowRun> {
    return rerunFailedJobs(this.client, runId);
  }

  // ============================================
  // Job & Log Operations
  // ============================================

  /**
   * Get jobs for a workflow run
   */
  async getJobs(runId: number): Promise<Job[]> {
    return getJobs(this.client, runId);
  }

  /**
   * Get a specific job by ID
   */
  async getJob(jobId: number): Promise<Job> {
    return getJob(this.client, jobId);
  }

  /**
   * Download job logs
   */
  async getJobLogs(jobId: number): Promise<string> {
    return getJobLogs(this.client, jobId);
  }

  /**
   * Get failed jobs from a workflow run
   */
  async getFailedJobs(runId: number): Promise<Job[]> {
    return getFailedJobs(this.client, runId);
  }

  // ============================================
  // Artifact Operations
  // ============================================

  /**
   * List artifacts for a workflow run
   */
  async listArtifacts(runId: number): Promise<Artifact[]> {
    return listArtifacts(this.client, runId);
  }

  /**
   * Get an artifact by ID
   */
  async getArtifact(artifactId: number): Promise<Artifact> {
    return getArtifact(this.client, artifactId);
  }

  /**
   * Download an artifact
   */
  async downloadArtifact(artifactId: number): Promise<Buffer> {
    return downloadArtifact(this.client, artifactId);
  }

  /**
   * Delete an artifact
   */
  async deleteArtifact(artifactId: number): Promise<void> {
    return deleteArtifact(this.client, artifactId);
  }

  /**
   * List all artifacts in the repository
   */
  async listRepoArtifacts(options?: {
    per_page?: number;
    page?: number;
    name?: string;
  }): Promise<Artifact[]> {
    return listRepoArtifacts(this.client, options);
  }

  // ============================================
  // Check Run Operations
  // ============================================

  /**
   * Create a check run
   */
  async createCheckRun(params: CreateCheckRunParams): Promise<CheckRun> {
    const check = await createCheckRun(this.client, params);
    return check;
  }

  /**
   * Update a check run
   */
  async updateCheckRun(
    checkRunId: number,
    params: UpdateCheckRunParams
  ): Promise<CheckRun> {
    const check = await updateCheckRun(this.client, checkRunId, params);

    // Emit event if check is completed
    if (params.status === 'completed' && this.eventEmitter) {
      this.eventEmitter.emitCheckRunCompleted(check);
    }

    return check;
  }

  /**
   * Get a check run by ID
   */
  async getCheckRun(checkRunId: number): Promise<CheckRun> {
    return getCheckRun(this.client, checkRunId);
  }

  /**
   * List check runs for a ref
   */
  async listCheckRuns(
    ref: string,
    options?: {
      check_name?: string;
      status?: 'queued' | 'in_progress' | 'completed';
      filter?: 'latest' | 'all';
      per_page?: number;
      page?: number;
    }
  ): Promise<CheckRun[]> {
    return listCheckRuns(this.client, ref, options);
  }

  /**
   * List check runs for a check suite
   */
  async listCheckRunsForSuite(
    checkSuiteId: number,
    options?: {
      check_name?: string;
      status?: 'queued' | 'in_progress' | 'completed';
      filter?: 'latest' | 'all';
      per_page?: number;
      page?: number;
    }
  ): Promise<CheckRun[]> {
    return listCheckRunsForSuite(this.client, checkSuiteId, options);
  }

  // ============================================
  // Polling Operations
  // ============================================

  /**
   * Create a status poller
   */
  createPoller(config?: Partial<PollingConfig>): StatusPoller {
    return createStatusPoller(this.client, config);
  }

  /**
   * Poll for a workflow run to complete
   */
  async pollUntilComplete(
    runId: number,
    config?: Partial<PollingConfig>
  ): Promise<WorkflowRun> {
    const run = await pollUntilComplete(this.client, runId, {
      ...config,
      onComplete: async (completedRun) => {
        config?.onComplete?.(completedRun);
        await this.handleWorkflowComplete(completedRun);
      },
    });
    return run;
  }

  /**
   * Wait for a workflow run with timeout
   */
  async waitForRun(
    runId: number,
    timeoutMs?: number,
    intervalMs?: number
  ): Promise<PollingResult> {
    return waitForRun(this.client, runId, timeoutMs, intervalMs);
  }

  /**
   * Start polling and return a handle
   */
  startPolling(
    runId: number,
    config?: Partial<PollingConfig>
  ): PollingHandle {
    const poller = this.createPoller({
      ...config,
      onComplete: async (run) => {
        config?.onComplete?.(run);
        await this.handleWorkflowComplete(run);
      },
    });
    return poller.start(runId);
  }

  // ============================================
  // High-Level Operations
  // ============================================

  /**
   * Trigger a workflow and wait for completion
   */
  async triggerAndWait(
    params: TriggerWorkflowParams,
    pollingConfig?: Partial<PollingConfig>
  ): Promise<WorkflowRun> {
    const run = await this.triggerWorkflow(params);
    return this.pollUntilComplete(run.id, pollingConfig);
  }

  /**
   * Get the configured CI workflow name
   */
  getCIWorkflow(): string | undefined {
    return this.config.workflows?.ci;
  }

  /**
   * Get the configured deploy workflow name
   */
  getDeployWorkflow(): string | undefined {
    return this.config.workflows?.deploy;
  }

  /**
   * Get the configured test workflow name
   */
  getTestWorkflow(): string | undefined {
    return this.config.workflows?.test;
  }

  // ============================================
  // Issue Tracker Integration
  // ============================================

  /**
   * Post workflow status to an issue
   *
   * @param issueNumber - The issue number to comment on
   * @param run - The workflow run to report on
   */
  async postWorkflowStatusToIssue(
    issueNumber: number,
    run: WorkflowRun
  ): Promise<void> {
    if (!this.issueTracker) {
      return;
    }

    const statusEmoji = this.getStatusEmoji(run.conclusion);
    const duration = this.formatDuration(run);

    const comment = `## ${statusEmoji} Workflow ${run.conclusion ?? 'completed'}

**Workflow**: \`${run.path}\`
**Branch**: \`${run.head_branch}\`
**Commit**: \`${run.head_sha.substring(0, 7)}\`
**Duration**: ${duration}

[View workflow run](${run.html_url})`;

    await this.issueTracker.addComment(String(issueNumber), comment);
  }

  /**
   * Post failed workflow details to an issue
   *
   * @param issueNumber - The issue number to comment on
   * @param run - The failed workflow run
   * @param failedJobs - The failed jobs in the run
   */
  async postWorkflowFailureToIssue(
    issueNumber: number,
    run: WorkflowRun,
    failedJobs: Job[]
  ): Promise<void> {
    if (!this.issueTracker) {
      return;
    }

    const jobDetails = failedJobs
      .map((job) => `- **${job.name}**: ${job.conclusion}`)
      .join('\n');

    const comment = `## :x: Workflow failed

**Workflow**: \`${run.path}\`
**Branch**: \`${run.head_branch}\`
**Commit**: \`${run.head_sha.substring(0, 7)}\`

### Failed Jobs
${jobDetails || 'No job details available'}

[View workflow run](${run.html_url})`;

    await this.issueTracker.addComment(String(issueNumber), comment);
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Handle workflow completion - emit events and optionally comment on issues
   */
  private async handleWorkflowComplete(run: WorkflowRun): Promise<void> {
    if (!this.eventEmitter) return;

    const failedJobs = run.conclusion === 'failure'
      ? await this.getFailedJobs(run.id)
      : [];

    this.eventEmitter.emitForWorkflowRun(run, failedJobs);
  }

  /**
   * Get status emoji for workflow conclusion
   */
  private getStatusEmoji(conclusion: WorkflowRun['conclusion']): string {
    switch (conclusion) {
      case 'success':
        return ':white_check_mark:';
      case 'failure':
        return ':x:';
      case 'cancelled':
        return ':no_entry_sign:';
      case 'timed_out':
        return ':alarm_clock:';
      case 'skipped':
        return ':fast_forward:';
      default:
        return ':grey_question:';
    }
  }

  /**
   * Format workflow duration for display
   */
  private formatDuration(run: WorkflowRun): string {
    const startTime = run.run_started_at
      ? new Date(run.run_started_at).getTime()
      : new Date(run.created_at).getTime();
    const endTime = new Date(run.updated_at).getTime();
    const durationMs = Math.max(0, endTime - startTime);

    const seconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }

  /**
   * Map a GitHub Actions WorkflowRun to a Latency PipelineRun.
   */
  private mapWorkflowRunToPipelineRun(run: WorkflowRun): PipelineRun {
    return {
      id: String(run.id),
      pipelineId: run.workflow_id ? String(run.workflow_id) : run.path ?? 'unknown',
      status: this.mapWorkflowStatus(run.status, run.conclusion),
      createdAt: new Date(run.created_at),
      startedAt: run.run_started_at ? new Date(run.run_started_at) : undefined,
      completedAt: run.status === 'completed' ? new Date(run.updated_at) : undefined,
      logsUrl: run.html_url,
    };
  }

  /**
   * Map GitHub Actions workflow status to Latency PipelineStatus.
   */
  private mapWorkflowStatus(
    status: WorkflowRun['status'],
    conclusion: WorkflowRun['conclusion']
  ): PipelineStatus {
    if (status === 'completed') {
      switch (conclusion) {
        case 'success':
          return 'completed';
        case 'failure':
        case 'timed_out':
          return 'failed';
        case 'cancelled':
        case 'skipped':
          return 'cancelled';
        default:
          return 'failed';
      }
    }

    // Non-completed status
    if (status === 'in_progress') {
      return 'running';
    }

    // queued, requested, waiting, pending, etc.
    return 'pending';
  }

  /**
   * Map a GitHub Actions Workflow to a Latency Pipeline.
   */
  private mapWorkflowToPipeline(workflow: Workflow): Pipeline {
    return {
      id: String(workflow.id),
      name: workflow.name,
      description: workflow.path,
      defaultBranch: undefined, // Workflows don't have a default branch concept
    };
  }
}

/**
 * Create a GitHubActionsPlugin instance
 */
export function createGitHubActionsPlugin(
  config: GitHubActionsConfig,
  eventBus?: EventBus
): GitHubActionsPlugin {
  return new GitHubActionsPlugin(config, eventBus);
}
