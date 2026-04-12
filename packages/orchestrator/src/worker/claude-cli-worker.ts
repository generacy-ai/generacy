import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createGitHubClient, createFeature } from '@generacy-ai/workflow-engine';
import type { QueueItem } from '../types/index.js';
import type { WorkerContext, ProcessFactory, ChildProcessHandle, Logger, JobEventEmitter } from './types.js';
import { getPhaseSequence } from './types.js';
import type { WorkerConfig } from './config.js';
import { PhaseResolver } from './phase-resolver.js';
import { LabelManager } from './label-manager.js';
import { StageCommentManager } from './stage-comment-manager.js';
import { GateChecker } from './gate-checker.js';
import { CliSpawner } from './cli-spawner.js';
import { OutputCapture } from './output-capture.js';
import type { SSEEventEmitter } from './output-capture.js';
import { RepoCheckout } from './repo-checkout.js';
import { PhaseLoop } from './phase-loop.js';
import { PrManager } from './pr-manager.js';
import { PrFeedbackHandler } from './pr-feedback-handler.js';
import { EpicPostTasks } from './epic-post-tasks.js';
import { ConversationLogger } from './conversation-logger.js';
import { AgentLauncher } from '../launcher/agent-launcher.js';
import { GenericSubprocessPlugin } from '../launcher/generic-subprocess-plugin.js';
import { conversationProcessFactory } from '../conversation/process-factory.js';

/**
 * Default ProcessFactory that uses Node's child_process.spawn.
 */
const defaultProcessFactory: ProcessFactory = {
  spawn(
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; signal?: AbortSignal },
  ): ChildProcessHandle {
    const child: ChildProcess = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => {
        resolve(code);
      });
      child.on('error', () => {
        resolve(1);
      });
    });

    return {
      stdin: null,
      stdout: child.stdout,
      stderr: child.stderr,
      pid: child.pid,
      kill: (signal?: NodeJS.Signals) => child.kill(signal),
      exitPromise,
    };
  },
};

/**
 * Dependencies that can be injected for testing.
 */
export interface ClaudeCliWorkerDeps {
  processFactory?: ProcessFactory;
  sseEmitter?: SSEEventEmitter;
  /** Callback for emitting job lifecycle events through the relay */
  jobEventEmitter?: JobEventEmitter;
}

/**
 * Top-level worker class that composes all sub-components to process
 * a QueueItem through the full speckit phase loop or route to specialized handlers.
 *
 * This class implements the WorkerHandler signature:
 *   `(item: QueueItem) => Promise<void>`
 *
 * It orchestrates:
 * - Repository checkout
 * - Command routing (address-pr-feedback → PrFeedbackHandler)
 * - Phase resolution from issue labels (for process/continue commands)
 * - Phase loop execution (CLI spawning, label management, gate checking)
 * - SSE event emission for dashboard streaming
 * - Error handling with structured label reporting
 */
export class ClaudeCliWorker {
  private readonly processFactory: ProcessFactory;
  private readonly sseEmitter?: SSEEventEmitter;
  private readonly jobEventEmitter?: JobEventEmitter;
  private readonly repoCheckout: RepoCheckout;
  private readonly phaseResolver: PhaseResolver;
  private readonly agentLauncher: AgentLauncher;

  constructor(
    private readonly config: WorkerConfig,
    private readonly logger: Logger,
    deps: ClaudeCliWorkerDeps = {},
  ) {
    this.processFactory = deps.processFactory ?? defaultProcessFactory;
    this.sseEmitter = deps.sseEmitter;
    this.jobEventEmitter = deps.jobEventEmitter;
    this.repoCheckout = new RepoCheckout(config.workspaceDir, logger);
    this.phaseResolver = new PhaseResolver();

    // AgentLauncher: plugin-based process dispatch (Phase 1 — unused by existing code paths)
    this.agentLauncher = new AgentLauncher(
      new Map([
        ['default', this.processFactory],
        ['interactive', conversationProcessFactory],
      ]),
    );
    this.agentLauncher.registerPlugin(new GenericSubprocessPlugin());
  }

  /**
   * Process a queue item through the full phase loop or route to specialized handlers.
   *
   * This is the entry point invoked by the WorkerDispatcher.
   *
   * Command routing (T020):
   * - `address-pr-feedback`: Routes to PrFeedbackHandler for PR review feedback
   * - `process` / `continue`: Standard phase loop processing
   *
   * For phase loop processing:
   * - Creates a WorkerContext
   * - Resolves the starting phase from issue labels
   * - Runs the phase loop to completion (or gate/error)
   */
  async handle(item: QueueItem): Promise<void> {
    const workerId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const workflowId = `${item.owner}/${item.repo}#${item.issueNumber}`;

    const workerLogger = this.logger.child({
      workerId,
      owner: item.owner,
      repo: item.repo,
      issue: item.issueNumber,
      workflowName: item.workflowName,
    });

    workerLogger.info('Worker started processing queue item');

    // Emit SSE workflow:started event
    this.sseEmitter?.({
      type: 'workflow:started',
      workflowId,
      data: {
        owner: item.owner,
        repo: item.repo,
        issueNumber: item.issueNumber,
        workflowName: item.workflowName,
        command: item.command,
      },
    });

    // Create a GitHub client scoped to the checkout directory
    let checkoutPath: string | undefined;
    const abortController = new AbortController();
    let labelManager: LabelManager | undefined;
    let phasesCompleted = false;
    let gateHit = false;

    try {
      // 1. Clone the default branch first (always works, even on first run)
      const defaultBranch = await this.repoCheckout.getDefaultBranch(item.owner, item.repo);
      checkoutPath = await this.repoCheckout.ensureCheckout(
        workerId,
        item.owner,
        item.repo,
        defaultBranch,
      );

      // Create GitHub client scoped to checkout dir
      const github = createGitHubClient(checkoutPath);

      // 2. Route address-pr-feedback command to PrFeedbackHandler (T020)
      if (item.command === 'address-pr-feedback') {
        workerLogger.info('Routing to PrFeedbackHandler for PR feedback addressing');

        const prFeedbackHandler = new PrFeedbackHandler(
          this.config,
          workerLogger,
          this.processFactory,
          this.sseEmitter,
        );

        await prFeedbackHandler.handle(item, checkoutPath);

        workerLogger.info('PR feedback addressing completed');

        this.sseEmitter?.({
          type: 'workflow:completed',
          workflowId,
          data: {
            command: 'address-pr-feedback',
            lastPhase: 'address-pr-feedback',
            totalPhases: 1,
          },
        });

        return;
      }

      // 3. Get issue details and resolve description
      const issue = await github.getIssue(item.owner, item.repo, item.issueNumber);
      const labels = issue.labels.map((l) =>
        typeof l === 'string' ? l : l.name,
      );

      // Prefer description from queue metadata (pre-fetched by LabelMonitorService),
      // fall back to the issue body/title from the GitHub fetch above.
      const description = (item.metadata?.description as string)
        || issue.body
        || issue.title
        || `Issue #${item.issueNumber}`;
      workerLogger.info(
        { source: item.metadata?.description ? 'metadata' : 'github' },
        'Resolved issue description',
      );

      // 4. Resolve starting phase (for process/continue commands)
      const startPhase = this.phaseResolver.resolveStartPhase(labels, item.command as 'process' | 'continue', item.workflowName);
      workerLogger.info({ startPhase, labels }, 'Resolved starting phase');

      // 5. Setup: ensure the feature branch exists and is checked out.
      //
      // The old workflow executor had an explicit setup phase that called
      // speckit.create_feature with the issue number. The new orchestrator
      // delegates phases to Claude CLI slash commands, but branch creation
      // must happen deterministically (with the correct issue number) before
      // any phase runs — otherwise the CLI operates on the default branch.
      //
      // createFeature is idempotent: if the branch/dir already exists it
      // checks out the existing branch and pulls latest from remote.
      const featureResult = await createFeature({
        description,
        number: item.issueNumber,
        cwd: checkoutPath,
      });

      if (featureResult.success) {
        workerLogger.info(
          {
            branch: featureResult.branch_name,
            created: featureResult.git_branch_created,
            featureDir: featureResult.feature_dir,
          },
          'Feature branch setup complete',
        );
      } else {
        throw new Error(
          `Failed to setup feature branch for issue #${item.issueNumber}: ${featureResult.error ?? 'unknown error'}`,
        );
      }

      // 6. Build WorkerContext
      const context: WorkerContext = {
        workerId,
        jobId,
        item,
        startPhase,
        github,
        logger: workerLogger,
        signal: abortController.signal,
        checkoutPath,
        issueUrl: `https://github.com/${item.owner}/${item.repo}/issues/${item.issueNumber}`,
        description,
      };

      // Helper to build job event base payload
      const jobEventBase = () => ({
        jobId,
        workflowName: item.workflowName,
        owner: item.owner,
        repo: item.repo,
        issueNumber: item.issueNumber,
      });

      // Emit job:created
      this.jobEventEmitter?.('job:created', {
        ...jobEventBase(),
        status: 'active',
        currentStep: startPhase,
      });

      // 7. Create sub-components
      labelManager = new LabelManager(
        github,
        item.owner,
        item.repo,
        item.issueNumber,
        workerLogger,
      );

      const stageCommentManager = new StageCommentManager(
        github,
        item.owner,
        item.repo,
        item.issueNumber,
        workerLogger,
      );

      const gateChecker = new GateChecker(workerLogger);

      const cliSpawner = new CliSpawner(
        this.processFactory,
        workerLogger,
        this.config.shutdownGracePeriodMs,
      );

      const conversationLogger = featureResult.feature_dir
        ? new ConversationLogger(featureResult.feature_dir)
        : undefined;

      const outputCapture = new OutputCapture(
        workflowId,
        workerLogger,
        this.sseEmitter,
        conversationLogger,
      );

      const prManager = new PrManager(
        github,
        item.owner,
        item.repo,
        item.issueNumber,
        workerLogger,
      );

      // 7b. On resume, clean up gate labels before starting the phase loop
      if (item.command === 'continue') {
        await labelManager.onResumeStart();
      }

      // 7c. Handle tasks-review gate resume for epics (T015)
      // When an epic resumes after tasks-review approval, run post-tasks directly
      // instead of re-entering the phase loop. The phase loop already completed
      // (specify → clarify → plan → tasks); we just need to create child issues.
      if (item.workflowName === 'speckit-epic' && item.command === 'continue') {
        if (labels.includes('completed:tasks-review')) {
          workerLogger.info('Epic tasks-review gate satisfied — running post-tasks directly');
          const epicPostTasks = new EpicPostTasks(workerLogger);
          const postTasksResult = await epicPostTasks.execute(context);

          if (postTasksResult.success) {
            workerLogger.info(
              { childIssues: postTasksResult.childIssues.length },
              'Epic post-tasks complete after tasks-review resume',
            );
          } else {
            workerLogger.error('Epic post-tasks failed after tasks-review resume');
          }

          this.sseEmitter?.({
            type: 'workflow:completed',
            workflowId,
            data: {
              command: item.command,
              lastPhase: 'tasks',
              totalPhases: 4,
            },
          });

          this.jobEventEmitter?.('job:completed', {
            ...jobEventBase(),
            status: 'completed',
            currentStep: 'tasks',
          });

          return;
        }
      }

      // 8. Execute the phase loop
      const phaseSequence = getPhaseSequence(item.workflowName);
      const phaseLoop = new PhaseLoop(workerLogger);
      const loopResult = await phaseLoop.executeLoop(context, this.config, {
        labelManager,
        stageCommentManager,
        gateChecker,
        cliSpawner,
        outputCapture,
        prManager,
        conversationLogger,
        jobEventEmitter: this.jobEventEmitter,
      }, phaseSequence);

      // 9. Handle completion
      if (loopResult.completed) {
        phasesCompleted = true;

        if (item.workflowName === 'speckit-epic') {
          // Epic workflows: create child issues and pause (do NOT complete workflow or mark PR ready)
          workerLogger.info('Epic phase loop complete — running post-tasks');
          const epicPostTasks = new EpicPostTasks(workerLogger);
          const postTasksResult = await epicPostTasks.execute(context);

          if (postTasksResult.success) {
            workerLogger.info(
              { childIssues: postTasksResult.childIssues.length },
              'Epic post-tasks complete — epic is now waiting for children',
            );
          } else {
            workerLogger.error('Epic post-tasks failed — epic may need manual intervention');
          }

          this.sseEmitter?.({
            type: 'workflow:completed',
            workflowId,
            data: {
              command: item.command,
              lastPhase: loopResult.lastPhase,
              totalPhases: loopResult.results.length,
            },
          });

          this.jobEventEmitter?.('job:completed', {
            ...jobEventBase(),
            status: 'completed',
            currentStep: loopResult.lastPhase,
          });
        } else {
          // Non-epic workflows: standard completion flow
          await labelManager.onWorkflowComplete();
          workerLogger.info('Marking PR as ready for review');
          await prManager.markReadyForReview();
          workerLogger.info('Workflow completed successfully — all phases done');

          this.sseEmitter?.({
            type: 'workflow:completed',
            workflowId,
            data: {
              command: item.command,
              lastPhase: loopResult.lastPhase,
              totalPhases: loopResult.results.length,
            },
          });

          this.jobEventEmitter?.('job:completed', {
            ...jobEventBase(),
            status: 'completed',
            currentStep: loopResult.lastPhase,
          });
        }
      } else if (loopResult.gateHit) {
        gateHit = true;
        workerLogger.info(
          { lastPhase: loopResult.lastPhase },
          'Workflow paused at review gate',
        );
      } else {
        // Phase failure
        workerLogger.error(
          { lastPhase: loopResult.lastPhase },
          'Workflow stopped due to phase failure',
        );

        this.sseEmitter?.({
          type: 'workflow:failed',
          workflowId,
          data: {
            command: item.command,
            lastPhase: loopResult.lastPhase,
            totalPhases: loopResult.results.length,
          },
        });

        this.jobEventEmitter?.('job:failed', {
          ...jobEventBase(),
          status: 'failed',
          currentStep: loopResult.lastPhase,
          error: loopResult.results.at(-1)?.error?.message ?? 'Phase failure',
        });
      }
    } catch (error) {
      if (phasesCompleted) {
        // All phases completed successfully — the failure is in post-completion
        // work (e.g. markReadyForReview, SSE emission). Log at warn level and
        // do NOT re-throw, so WorkerDispatcher calls queue.complete() instead
        // of queue.release().
        workerLogger.warn(
          { error: String(error) },
          'Post-completion step failed (all phases completed successfully)',
        );
      } else {
        workerLogger.error(
          { error: String(error) },
          'Worker encountered an unhandled error',
        );

        this.sseEmitter?.({
          type: 'workflow:failed',
          workflowId,
          data: {
            command: item.command,
            error: error instanceof Error ? error.message : String(error),
          },
        });

        this.jobEventEmitter?.('job:failed', {
          jobId,
          workflowName: item.workflowName,
          owner: item.owner,
          repo: item.repo,
          issueNumber: item.issueNumber,
          status: 'failed',
          currentStep: 'unknown',
          error: error instanceof Error ? error.message : String(error),
        });

        throw error;
      }
    } finally {
      // Cleanup: abort any in-flight operations
      abortController.abort();

      // Ensure agent:in-progress is cleaned up on every exit path.
      // This is a no-op if onWorkflowComplete() or onError() already removed it.
      // Gate hits intentionally leave agent:in-progress — the guard prevents unwanted cleanup.
      if (labelManager && !gateHit) {
        await labelManager.ensureCleanup();
      }
    }
  }

}
