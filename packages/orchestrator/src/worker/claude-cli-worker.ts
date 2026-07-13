import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveSiblingWorkdirs, tryLoadWorkspaceConfig, tryLoadOrchestratorSettings, findWorkspaceConfigPath } from '@generacy-ai/config';
import { createGitHubClient, createFeature, registerProcessLauncher, clearProcessLauncher, siblingFanoutHandler, FilesystemWorkflowStore } from '@generacy-ai/workflow-engine';
import type { LaunchFunctionRequest, LaunchFunctionHandle, LinkedPR, SiblingFanoutContext } from '@generacy-ai/workflow-engine';
import type { QueueItem, PhaseTracker } from '../types/index.js';
import type { WorkerContext, ProcessFactory, ChildProcessHandle, Logger, JobEventEmitter } from './types.js';
import { ValidateFixHandler } from './validate-fix-handler.js';
import { getPhaseSequence } from './types.js';
import type { WorkerConfig } from './config.js';
import { applyRepoValidateOverrides, applyRepoAgentOverrides } from './config.js';
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
import { MergeConflictHandler } from './merge-conflict-handler.js';
import { readPauseContext, clearPauseContext } from './pause-context.js';
import type { HandlerOutcome } from './handler-outcome.js';
import { EpicPostTasks } from './epic-post-tasks.js';
import { ConversationLogger } from './conversation-logger.js';
import { createAgentLauncher } from '../launcher/launcher-setup.js';
import type { AgentLauncher } from '../launcher/agent-launcher.js';
import { CredhelperHttpClient } from '../launcher/credhelper-client.js';
import { CredhelperUnavailableError } from '../launcher/credhelper-errors.js';
import { JitTokenError } from '@generacy-ai/control-plane';
import { conversationProcessFactory } from '../conversation/process-factory.js';
import type { WorkerResult } from './worker-result.js';
import { isTerminalLabelOpError } from './terminal-label-op-error.js';

/**
 * Load linkedPRs from workflow state files in the checkout directory.
 * Reads `.generacy/workflow-state-*.json` files and returns the first
 * non-empty linkedPRs array found. Best-effort: returns empty on any error.
 */
async function loadLinkedPRsFromState(checkoutPath: string, logger: Logger): Promise<LinkedPR[]> {
  const stateDir = path.join(checkoutPath, '.generacy');
  try {
    const files = await fs.readdir(stateDir);
    for (const file of files) {
      if (file.startsWith('workflow-state-') && file.endsWith('.json')) {
        try {
          const content = await fs.readFile(path.join(stateDir, file), 'utf-8');
          const data = JSON.parse(content) as { linkedPRs?: LinkedPR[] };
          if (Array.isArray(data.linkedPRs) && data.linkedPRs.length > 0) {
            logger.info(
              { linkedPRCount: data.linkedPRs.length, stateFile: file },
              'Loaded linkedPRs from workflow state',
            );
            return data.linkedPRs;
          }
        } catch {
          // Skip malformed state files
        }
      }
    }
  } catch {
    // No state directory or read error — fine, no linkedPRs
  }
  return [];
}

/**
 * Default ProcessFactory that uses Node's child_process.spawn.
 */
export const defaultProcessFactory: ProcessFactory = {
  spawn(
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; signal?: AbortSignal; uid?: number; gid?: number; detached?: boolean },
  ): ChildProcessHandle {
    const child: ChildProcess = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.uid !== undefined && { uid: options.uid }),
      ...(options.gid !== undefined && { gid: options.gid }),
      ...(options.detached !== undefined && { detached: options.detached }),
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
  /** Token provider for GitHub operations in the orchestrator process (e.g. sibling fan-out) */
  tokenProvider?: () => Promise<string | undefined>;
  /**
   * Optional PhaseTracker injected by the worker-mode wiring for #892's
   * ValidateFixHandler dedupe. Also used by the #849 paired-clear callback.
   * When absent, ValidateFixHandler is not constructed and the fix-cycle
   * behavior degrades to "same as today" (base-advance re-runs still occur).
   */
  phaseTracker?: PhaseTracker;
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
  private readonly tokenProvider?: () => Promise<string | undefined>;
  private readonly phaseTracker?: PhaseTracker;
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
    this.tokenProvider = deps.tokenProvider;
    this.phaseTracker = deps.phaseTracker;
    this.repoCheckout = new RepoCheckout(config.workspaceDir, logger);
    this.phaseResolver = new PhaseResolver();

    // Credential role fail-fast check: if role is configured, the daemon must be reachable
    const socketPath = process.env['GENERACY_CREDHELPER_SOCKET'] ?? '/run/generacy-credhelper/control.sock';
    let credhelperClient: CredhelperHttpClient | undefined;
    if (config.credentialRole) {
      if (!existsSync(socketPath)) {
        throw new CredhelperUnavailableError(socketPath);
      }
      credhelperClient = new CredhelperHttpClient({ socketPath });
    } else if (existsSync(socketPath)) {
      // Daemon is available but no role configured — wire client for opportunistic use
      credhelperClient = new CredhelperHttpClient({ socketPath });
    }

    // AgentLauncher: plugin-based process dispatch
    this.agentLauncher = createAgentLauncher({
      default: this.processFactory,
      interactive: conversationProcessFactory,
    }, credhelperClient);

    // Wire workflow-engine's process launcher to route through AgentLauncher
    clearProcessLauncher();
    registerProcessLauncher(async (request: LaunchFunctionRequest): Promise<LaunchFunctionHandle> => {
      const launchHandle = await this.agentLauncher.launch({
        intent: {
          kind: request.kind,
          command: request.command,
          ...(request.kind === 'generic-subprocess'
            ? { args: request.args }
            : {}),
          env: request.env,
          detached: request.detached,
        } as import('../launcher/types.js').LaunchIntent,
        cwd: request.cwd,
        env: request.env,
        signal: request.signal,
        detached: request.detached,
      });
      return {
        stdout: launchHandle.process.stdout,
        stderr: launchHandle.process.stderr,
        pid: launchHandle.process.pid,
        kill: (sig?: NodeJS.Signals) => launchHandle.process.kill(sig),
        exitPromise: launchHandle.process.exitPromise,
      };
    });
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
   *
   * Returns a `WorkerResult` discriminated union:
   * - `{ status: 'completed' }` — happy path (incl. gate hits and phase failures
   *   that self-terminated cleanly).
   * - `{ status: 'failed-terminal', failureMetadata }` — a `TerminalLabelOpError`
   *   was caught inside the phase loop or the outer catch. The dispatcher marks
   *   the item completed (not released) and emits the `stage: 'label-op'` alert.
   *
   * All other unhandled throws propagate; the dispatcher catches them and
   * releases the item (unchanged behavior for generic errors).
   */
  async handle(item: QueueItem): Promise<WorkerResult> {
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
    let workerResult: WorkerResult = { status: 'completed' };

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
          this.agentLauncher,
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

        return { status: 'completed' };
      }

      // 2b. #898: route resolve-merge-conflicts to MergeConflictHandler.
      if (item.command === 'resolve-merge-conflicts') {
        workerLogger.info('Routing to MergeConflictHandler for merge-conflict resolution');

        // #902 FR-003: read the pause-context sidecar written by the phase-loop
        // pause site. Populates `metadata.phase` — the single source of truth
        // for the interrupted phase. Absence triggers the handler's fail-loud
        // path (FR-004) — never re-derived from labels.
        const pauseContext = await readPauseContext(checkoutPath, workflowId);
        if (pauseContext) {
          item.metadata = {
            ...(item.metadata ?? {}),
            phase: pauseContext.phase,
          };
          workerLogger.info(
            { pausePhase: pauseContext.phase, writtenAt: pauseContext.writtenAt },
            '#902: loaded pause-context sidecar — populated metadata.phase',
          );
        } else {
          workerLogger.warn(
            { workflowId },
            '#902: pause-context sidecar missing — MergeConflictHandler will enter fail-loud path',
          );
        }

        const mergeConflictHandler = new MergeConflictHandler(
          this.config,
          workerLogger,
          this.agentLauncher,
          this.sseEmitter,
        );

        const outcome: HandlerOutcome = await mergeConflictHandler.handle(item, checkoutPath);

        workerLogger.info(
          { outcome: outcome.outcome },
          'Merge-conflict resolution completed',
        );

        this.sseEmitter?.({
          type: 'workflow:completed',
          workflowId,
          data: {
            command: 'resolve-merge-conflicts',
            lastPhase: 'resolve-merge-conflicts',
            totalPhases: 1,
          },
        });

        // #902 FR-002/FR-008: on re-armed, build the rearm item and hand it to
        // the dispatcher via `postComplete`. Dispatcher fires `enqueueIfAbsent`
        // AFTER `queue.complete()` — the current itemKey is freed first, so no
        // self-collision on the shared itemKey `<owner>/<repo>#<issue>`.
        if (outcome.outcome === 're-armed') {
          const rearmItem: QueueItem = {
            owner: item.owner,
            repo: item.repo,
            issueNumber: item.issueNumber,
            workflowName: item.workflowName,
            command: 'continue',
            priority: Date.now(),
            enqueuedAt: new Date().toISOString(),
            queueReason: 'resume',
            userId: item.userId,
            metadata: {
              startPhase: outcome.startPhase,
              resumeReason: 'merge-conflict-resolved',
            },
          };

          // Best-effort sidecar cleanup — a stale file left behind is
          // overwritten by the next pause (writes are unconditional).
          try {
            await clearPauseContext(checkoutPath, workflowId);
          } catch (err) {
            workerLogger.warn(
              { err: String(err), workflowId },
              '#902: failed to clear pause-context sidecar — will be overwritten on next pause',
            );
          }

          return {
            status: 'completed',
            postComplete: { kind: 'rearm', rearmItem },
          };
        }

        return { status: 'completed' };
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

      // 5b. Resolve sibling workdirs from workspace config
      let siblingWorkdirs: Record<string, string> = {};
      const configPath = findWorkspaceConfigPath(checkoutPath);
      if (configPath) {
        const workspaceConfig = tryLoadWorkspaceConfig(configPath);
        if (workspaceConfig) {
          siblingWorkdirs = resolveSiblingWorkdirs(workspaceConfig, checkoutPath);
          if (Object.keys(siblingWorkdirs).length > 0) {
            workerLogger.info(
              { siblingCount: Object.keys(siblingWorkdirs).length, siblings: Object.keys(siblingWorkdirs) },
              'Resolved sibling workdirs from workspace config',
            );
          }
        }
      }

      // 5c. Apply per-repo validate-command overrides from the target repo's
      // .generacy/config.yaml. The orchestrator's global validate defaults are
      // monorepo-shaped (`pnpm test && pnpm build`); repos with a different
      // shape (e.g. a single-package Astro site with no `test` script) override
      // them so the validate phase doesn't fail on a missing script.
      const orchSettings = configPath ? tryLoadOrchestratorSettings(configPath) : null;
      const effectiveConfig = applyRepoAgentOverrides(
        applyRepoValidateOverrides(this.config, orchSettings),
        orchSettings,
      );
      if (effectiveConfig !== this.config) {
        workerLogger.info(
          {
            validateCommand: effectiveConfig.validateCommand,
            preValidateCommand: effectiveConfig.preValidateCommand,
            agents: effectiveConfig.agents,
          },
          'Applied per-repo overrides from .generacy/config.yaml',
        );
      }

      // 6. Build WorkerContext
      // #892: surface resume identity so PhaseLoop's validate `catch` can gate
      // the ValidateFixHandler on the base-advance path.
      const md = (item.metadata ?? {}) as Record<string, unknown>;
      const resumeReason = md['resumeReason'] === 'base-advance' ? 'base-advance' as const : undefined;
      const baseSha = typeof md['baseSha'] === 'string' ? (md['baseSha'] as string) : undefined;

      const context: WorkerContext = {
        workerId,
        jobId,
        item,
        startPhase,
        github,
        logger: workerLogger,
        signal: abortController.signal,
        checkoutPath,
        branch: featureResult.branch_name,
        issueUrl: `https://github.com/${item.owner}/${item.repo}/issues/${item.issueNumber}`,
        description,
        siblingWorkdirs,
        ...(resumeReason ? { resumeReason } : {}),
        ...(baseSha ? { baseSha } : {}),
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
        this.agentLauncher,
        workerLogger,
        this.config.shutdownGracePeriodMs,
        this.config.credentialRole,
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

          return { status: 'completed' };
        }
      }

      // 8. Execute the phase loop
      const phaseSequence = getPhaseSequence(item.workflowName);
      const phaseLoop = new PhaseLoop(workerLogger);

      // #892: construct ValidateFixHandler only when PhaseTracker is available.
      // The handler's dedupe surface requires it; without Redis the fix-cycle
      // degrades to "same as today" (base-advance re-runs still occur).
      const jobEmitter = this.jobEventEmitter;
      const validateFixEmit = jobEmitter
        ? (channel: string, payload: unknown): void => {
            // Payload shape is always an object literal at the call site; cast
            // it into the record shape the JobEventEmitter expects.
            jobEmitter(channel, payload as Record<string, unknown>);
          }
        : undefined;
      const validateFixHandler = this.phaseTracker
        ? new ValidateFixHandler(
            effectiveConfig,
            this.agentLauncher,
            this.phaseTracker,
            workerLogger,
            validateFixEmit,
          )
        : undefined;

      const loopResult = await phaseLoop.executeLoop(context, effectiveConfig, {
        labelManager,
        stageCommentManager,
        gateChecker,
        cliSpawner,
        outputCapture,
        prManager,
        conversationLogger,
        jobEventEmitter: this.jobEventEmitter,
        ...(validateFixHandler ? { validateFixHandler } : {}),
        phaseAfterHandlers: [
          // Fan-out: commit sibling changes, push, open draft PRs, persist linkedPRs to state.
          async () => {
            const siblings = context.siblingWorkdirs ?? {};
            if (Object.keys(siblings).length === 0) return;
            const store = new FilesystemWorkflowStore(context.checkoutPath);
            const state = await store.load(workflowId);
            if (!state) return;
            const fanoutCtx: SiblingFanoutContext = {
              primaryWorkdir: context.checkoutPath,
              siblingWorkdirs: siblings,
              issueNumber: item.issueNumber,
              primaryRepoName: item.repo,
              org: item.owner,
              workflowStore: store,
              workflowState: state,
              logger: workerLogger,
              tokenProvider: this.tokenProvider,
            };
            await siblingFanoutHandler(fanoutCtx);
          },
          // Reload linkedPRs from workflow state so gate evaluation can access context.linkedPRs.
          async () => {
            const linkedPRs = await loadLinkedPRsFromState(context.checkoutPath, workerLogger);
            if (linkedPRs.length > 0) {
              context.linkedPRs = linkedPRs;
            }
          },
        ],
      }, phaseSequence);

      // 9. Handle terminal label-op failure (#889): translate into WorkerResult
      //    so the dispatcher completes the item instead of releasing it. The
      //    dispatcher's terminalFailureHandler emits the operator-facing alert.
      if (loopResult.status === 'failed-terminal' && loopResult.failureMetadata) {
        workerLogger.error(
          { failureMetadata: loopResult.failureMetadata },
          'Phase loop returned failed-terminal — surfacing as WorkerResult.failed-terminal',
        );
        workerResult = {
          status: 'failed-terminal',
          failureMetadata: loopResult.failureMetadata,
        };
        return workerResult;
      }

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
          await prManager.markReadyForReview(context.linkedPRs);
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
        if (error instanceof JitTokenError) {
          workerLogger.warn(
            { code: error.code, message: error.message },
            'JIT GitHub token refresh failed during post-completion step (all phases completed successfully)',
          );
        } else {
          workerLogger.warn(
            { error: String(error) },
            'Post-completion step failed (all phases completed successfully)',
          );
        }
      } else if (isTerminalLabelOpError(error)) {
        // #889: LabelManager retry exhaustion outside the phase loop (e.g. in
        // onResumeStart or onWorkflowComplete). Translate into WorkerResult so
        // the dispatcher completes the item instead of releasing it.
        workerLogger.error(
          { site: error.site, labelOp: error.labelOp, ghStderr: error.ghStderr },
          'Worker caught TerminalLabelOpError — surfacing as WorkerResult.failed-terminal',
        );
        workerResult = {
          status: 'failed-terminal',
          failureMetadata: {
            site: error.site,
            labelOp: error.labelOp,
            ghStderr: error.ghStderr,
          },
        };
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

    return workerResult;
  }

}
