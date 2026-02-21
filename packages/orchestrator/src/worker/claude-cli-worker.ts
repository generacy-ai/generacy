import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createGitHubClient } from '@generacy-ai/workflow-engine';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { QueueItem } from '../types/index.js';
import type { WorkerContext, ProcessFactory, ChildProcessHandle, Logger } from './types.js';
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
  private readonly repoCheckout: RepoCheckout;
  private readonly phaseResolver: PhaseResolver;

  constructor(
    private readonly config: WorkerConfig,
    private readonly logger: Logger,
    deps: ClaudeCliWorkerDeps = {},
  ) {
    this.processFactory = deps.processFactory ?? defaultProcessFactory;
    this.sseEmitter = deps.sseEmitter;
    this.repoCheckout = new RepoCheckout(config.workspaceDir, logger);
    this.phaseResolver = new PhaseResolver();
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

      // 3. Get issue labels to resolve starting phase
      const issue = await github.getIssue(item.owner, item.repo, item.issueNumber);
      const labels = issue.labels.map((l) =>
        typeof l === 'string' ? l : l.name,
      );

      // 4. Resolve starting phase (for process/continue commands)
      const startPhase = this.phaseResolver.resolveStartPhase(labels, item.command as 'process' | 'continue');
      workerLogger.info({ startPhase, labels }, 'Resolved starting phase');

      // 5. If resuming (has completed phases), find and checkout the feature branch
      if (startPhase !== 'specify') {
        const featureBranch = await this.resolveFeatureBranch(
          github, item.owner, item.repo, item.issueNumber, workerLogger,
        );
        if (featureBranch) {
          workerLogger.info({ featureBranch }, 'Switching to existing feature branch for resume');
          await this.repoCheckout.switchBranch(checkoutPath, featureBranch);
        }
      }

      // 6. Build WorkerContext
      const context: WorkerContext = {
        workerId,
        item,
        startPhase,
        github,
        logger: workerLogger,
        signal: abortController.signal,
        checkoutPath,
        issueUrl: `https://github.com/${item.owner}/${item.repo}/issues/${item.issueNumber}`,
      };

      // 7. Create sub-components
      const labelManager = new LabelManager(
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

      const outputCapture = new OutputCapture(
        workflowId,
        workerLogger,
        this.sseEmitter,
      );

      const prManager = new PrManager(
        github,
        item.owner,
        item.repo,
        item.issueNumber,
        workerLogger,
      );

      // 8. Execute the phase loop
      const phaseLoop = new PhaseLoop(workerLogger);
      const loopResult = await phaseLoop.executeLoop(context, this.config, {
        labelManager,
        stageCommentManager,
        gateChecker,
        cliSpawner,
        outputCapture,
        prManager,
      });

      // 9. Handle completion
      if (loopResult.completed) {
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
      } else if (loopResult.gateHit) {
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
      }
    } catch (error) {
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

      throw error;
    } finally {
      // Cleanup: abort any in-flight operations
      abortController.abort();
    }
  }

  /**
   * Find the feature branch for an issue by checking for an existing PR.
   *
   * When resuming a workflow, the feature branch was created during the first
   * run's setup phase. We find it by searching for an open draft PR that
   * references the issue number.
   *
   * @returns The branch name, or undefined if no feature branch was found.
   */
  private async resolveFeatureBranch(
    github: GitHubClient,
    owner: string,
    repo: string,
    issueNumber: number,
    logger: Logger,
  ): Promise<string | undefined> {
    try {
      // Search remote branches for one starting with the issue number
      const branches = await github.listBranches(owner, repo);
      const featureBranch = branches.find((b) => b.startsWith(`${issueNumber}-`));

      if (featureBranch) {
        logger.info({ featureBranch, issueNumber }, 'Found feature branch by issue number prefix');
        return featureBranch;
      }

      logger.info({ issueNumber }, 'No feature branch found for issue');
      return undefined;
    } catch (error) {
      logger.warn(
        { error: String(error), issueNumber },
        'Failed to resolve feature branch (non-fatal)',
      );
      return undefined;
    }
  }
}
