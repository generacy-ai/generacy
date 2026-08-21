import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveSiblingWorkdirs, tryLoadWorkspaceConfig, tryLoadOrchestratorSettings, findWorkspaceConfigPath } from '@generacy-ai/config';
import { createGitHubClient, createFeature, registerProcessLauncher, clearProcessLauncher, siblingFanoutHandler, FilesystemWorkflowStore } from '@generacy-ai/workflow-engine';
import type { LaunchFunctionRequest, LaunchFunctionHandle, LinkedPR, SiblingFanoutContext } from '@generacy-ai/workflow-engine';
import type { QueueItem, PhaseTracker, PrFeedbackMetadata } from '../types/index.js';
import type { WorkerContext, ProcessFactory, ChildProcessHandle, Logger, JobEventEmitter, WorkflowPhase } from './types.js';
import { getPhaseSequence } from './types.js';
import type { WorkerConfig } from './config.js';
import {
  applyRepoValidateOverrides,
  applyRepoAgentOverrides,
  resolveWorkflowOverrides,
} from './config.js';
import { PhaseResolver } from './phase-resolver.js';
import { LabelManager } from './label-manager.js';
import { StageCommentManager } from './stage-comment-manager.js';
import { GateChecker } from './gate-checker.js';
import { CliSpawner } from './cli-spawner.js';
import { OutputCapture } from './output-capture.js';
import type { SSEEventEmitter } from './output-capture.js';
import { RepoCheckout } from './repo-checkout.js';
import { PhaseLoop } from './phase-loop.js';
import { RemediateExecutor } from './remediate-executor.js';
import { ReviewExecutor } from './review-executor.js';
import { SeedAwareReviewExecutor } from './seed-aware-review-executor.js';
import {
  readReviewArtifactSync,
  readReviewArtifact,
  clearReviewArtifact,
} from './review-artifact.js';
import { parseExternalFeedback } from './pr-feedback-parser.js';
import { writeExternalFeedbackSeed } from './external-feedback-seed.js';
import { resolveExternalFeedbackThreads } from './external-feedback-resolver.js';
import { PrManager } from './pr-manager.js';
import { ReviewPoster } from './review-poster.js';
import { PrFeedbackHandler } from './pr-feedback-handler.js';
import { MergeConflictHandler } from './merge-conflict-handler.js';
import { readPauseContext, clearPauseContext } from './pause-context.js';
import type { HandlerOutcome, ReviewScope } from './handler-outcome.js';
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
 * True when `headRef` is a `<N>-…` feature branch for `issueNumber`, tolerant
 * of the zero-padding the default branch pattern applies. The default config
 * uses `{paddedNumber}-{slug}` with `numberPadding: 3`, so issue #42's real
 * branch is `042-slug`. A literal `^42-` prefix test misses `042-slug`,
 * mis-counts linked PRs as zero, and drops the head-ref checkout into the
 * `createFeature` fresh-slug path — the #1043 duplicate-PR regression this
 * head-ref resolution (SC-004) exists to prevent. Compare the leading numeric
 * segment by value so any padding width matches.
 */
function headRefMatchesIssue(headRef: string, issueNumber: number): boolean {
  const match = /^(\d+)-/.exec(headRef);
  if (!match || !match[1]) return false;
  return Number.parseInt(match[1], 10) === issueNumber;
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
   * Optional PhaseTracker injected by the worker-mode wiring. Used by the #849
   * paired-clear callback. When absent, the paired-clear degrades to a no-op.
   */
  phaseTracker?: PhaseTracker;
  /**
   * #942: Optional repeat-failure history tracker. Threaded into PhaseLoopDeps
   * so `escalateAndAlert` can count prior same-fingerprint failures. When
   * absent, `-repeated` escalation degrades to a no-op (occurrence stays at 1).
   */
  failureFingerprintTracker?: import('../services/failure-fingerprint-tracker.js').FailureFingerprintTracker;
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
  private readonly failureFingerprintTracker?: import('../services/failure-fingerprint-tracker.js').FailureFingerprintTracker;
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
    this.failureFingerprintTracker = deps.failureFingerprintTracker;
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

      // 2. Route address-pr-feedback command.
      // #1130: with the review/remediate epic enabled, this command no longer
      // runs a second fix CLI. Instead it parses dual-source external feedback,
      // seeds the shared review→remediate loop (below, after the PR branch is
      // checked out), and lets the SeedAwareReviewExecutor drive remediation —
      // one live fix path (Change 2/3). When the flag is OFF the review phase is
      // absent from the effective sequence, so we retain the legacy standalone
      // fixer to keep existing clusters byte-identical until the epic ships.
      if (item.command === 'address-pr-feedback' && !this.config.reviewPhaseEnabled) {
        workerLogger.info(
          'Routing to PrFeedbackHandler for PR feedback addressing (review phase disabled)',
        );

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
              // #1131: transport the resolution scope to the review executor via
              // the queue item (the pause-context sidecar is cleared just below).
              // `undefined` for the whole-branch fallback / flag-OFF re-arm.
              reviewScope: outcome.reviewScope,
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
      // #1121: thread reviewPhaseEnabled so the resolver's effective sequence
      // matches the phase loop — with the flag off, `review` is excluded and a
      // requeue completed through `implement` resolves to `validate`, not
      // `review`. Sourced from the base config (repo-agent overrides never
      // touch this flag, so it equals effectiveConfig.reviewPhaseEnabled).
      // #1130: address-pr-feedback (flag ON) enters the shared loop directly at
      // `review` — the SeedAwareReviewExecutor consumes the seed written below
      // and synthesizes a changes-required verdict, so the loop remediates the
      // external ask through the same review→remediate machinery.
      const startPhase = item.command === 'address-pr-feedback'
        ? ('review' as const)
        : this.phaseResolver.resolveStartPhase(
            labels,
            item.command as 'process' | 'continue',
            item.workflowName,
            this.config.reviewPhaseEnabled,
            this.config.ciMergeGateEnabled,
          );
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
      //
      // #1159 FR-006/FR-007 (Q4→C): on the `address-pr-feedback` re-entry the
      // working branch MUST be resolved from the PR head ref, not derived from
      // createFeature({ number }). The issue-derived slug is a *guess* that
      // diverges under #1043 slug drift; committing to it lands the remediation
      // on a stale branch and opens a duplicate PR instead of updating the
      // existing one. Apply the zero/one/many linked-open-PR rule:
      //   exactly one → getPullRequest(prNumber).head.ref + switchBranch
      //                 (mirrors pr-feedback-handler.ts:230; budget preserved)
      //   zero        → fresh-request: fall through to createFeature (budget 0)
      //   more than one → genuine ambiguity: park this poll without mutation and
      //                 surface for operator attention (guessing risks committing
      //                 to the wrong PR or opening a third).
      let branchAlreadyCheckedOut = false;
      // Branch name + feature dir outlive the setup blocks below (used when
      // building WorkerContext and the ConversationLogger). On the head-ref
      // path there is no createFeature call, so these are populated from the PR
      // head ref (branch) with no feature dir; on the fresh-request path they
      // come from createFeature.
      let resolvedBranch: string | undefined;
      let featureDir: string | undefined;
      if (item.command === 'address-pr-feedback') {
        const setupMeta = item.metadata as PrFeedbackMetadata | undefined;
        const setupPrNumber = setupMeta?.prNumber;
        if (!setupPrNumber) {
          throw new Error('Missing prNumber in metadata for address-pr-feedback command');
        }

        // Count linked open PRs on this issue's `<N>-*` branches (the #1043
        // enumeration pattern). Only the count drives the zero/one/many rule;
        // the head ref itself comes from the known metadata prNumber. Match by
        // numeric prefix value (not a literal `^<N>-` regex) so zero-padded
        // branches like `042-slug` count for issue #42 under the default
        // `{paddedNumber}` pattern (numberPadding: 3).
        const openPrs = await github.listOpenPullRequests(item.owner, item.repo);
        const linkedOpenPrs = openPrs.filter((pr) => headRefMatchesIssue(pr.head.ref, item.issueNumber));

        if (linkedOpenPrs.length > 1) {
          workerLogger.warn(
            {
              issueNumber: item.issueNumber,
              prNumber: setupPrNumber,
              linkedPrNumbers: linkedOpenPrs.map((pr) => pr.number),
              linkedBranches: linkedOpenPrs.map((pr) => pr.head.ref),
              gate: 'ambiguous-linked-prs',
            },
            '#1159: parking address-pr-feedback poll — >1 linked open PR, operator attention required (no mutation)',
          );
          // Apply a blocked:* label so the ambiguity surfaces once for the
          // operator instead of re-enqueuing + re-parking on every monitor
          // poll. The PR-feedback monitor's `blocked:*` short-circuit then
          // suppresses re-enqueue while the label persists; removing it (after
          // closing/merging the duplicate PRs) re-arms the trigger. Best-effort:
          // a label-apply failure must not turn the mutation-free park into a
          // throw, so we swallow and let the next poll retry.
          try {
            await github.addLabels(item.owner, item.repo, item.issueNumber, [
              'blocked:ambiguous-linked-prs',
            ]);
          } catch (labelError) {
            workerLogger.warn(
              { issueNumber: item.issueNumber, err: labelError },
              '#1159: failed to apply blocked:ambiguous-linked-prs on park — non-fatal, will re-check next poll',
            );
          }
          return { status: 'completed' };
        }

        if (linkedOpenPrs.length === 1) {
          const pr = await github.getPullRequest(item.owner, item.repo, setupPrNumber);
          const headRef = pr.head.ref;
          await this.repoCheckout.switchBranch(checkoutPath, headRef);
          branchAlreadyCheckedOut = true;
          resolvedBranch = headRef;
          // #1159 FR-007 / T006: with HEAD now on the PR head ref,
          // PrManager.ensureDraftPr's getCurrentBranch() == headRef, so
          // findPRForBranch(headRef) resolves the existing PR and
          // commitPushAndEnsurePr('remediate') updates it in place — no
          // duplicate PR under #1043 slug drift. No extra guard required.
          workerLogger.info(
            { issueNumber: item.issueNumber, prNumber: setupPrNumber, headRef },
            '#1159: checked out PR head ref for address-pr-feedback (budget preserved)',
          );
        }
        // linkedOpenPrs.length === 0 → fall through to createFeature (fresh request).
      }

      if (!branchAlreadyCheckedOut) {
        const featureResult = await createFeature({
          description,
          number: item.issueNumber,
          cwd: checkoutPath,
        });

        if (featureResult.success) {
          resolvedBranch = featureResult.branch_name;
          featureDir = featureResult.feature_dir;
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
      }

      // 5a2. #1130: address-pr-feedback (flag ON) — parse dual-source external
      // feedback off the PR (now that its branch is checked out) and seed the
      // review→remediate loop. The seed-aware executor (injected below) consumes
      // it on the first `review` round.
      if (item.command === 'address-pr-feedback') {
        const feedbackMeta = item.metadata as PrFeedbackMetadata | undefined;
        const prNumber = feedbackMeta?.prNumber;
        if (!prNumber) {
          throw new Error('Missing prNumber in metadata for address-pr-feedback command');
        }

        const findings = await parseExternalFeedback({
          github,
          owner: item.owner,
          repo: item.repo,
          prNumber,
          checkoutPath,
          logger: workerLogger,
        });

        if (findings.length === 0) {
          // No trusted external feedback — nothing to remediate. Complete
          // without seeding (an empty seed is never written) so the loop never
          // enters `review` with a null seed and spawns a real review CLI.
          //
          // #1130 finding #2: this early return happens BEFORE `labelManager` is
          // constructed (~line 630), so we must clear the monitor-applied gate
          // label here — otherwise it is stranded forever. The monitor's trust
          // check runs without the repo `.generacy/comment-trust.yaml` config
          // (it has no checkout), while `parseExternalFeedback` loads it via
          // `tryLoadCommentTrustConfig`; a comment the monitor trusts can be
          // untrusted by the stricter repo config, yielding 0 findings here after
          // the monitor already added `waiting-for:address-pr-feedback` and
          // enqueued. Without this clear, cockpit/operators see a stuck gate and
          // the monitor keeps churning. Best-effort — mirrors the legacy
          // handler's Case A cleanup (`removeFeedbackLabel` + the `finally`
          // `agent:in-progress` clear). Removing an absent label is a no-op.
          try {
            await github.removeLabels(item.owner, item.repo, item.issueNumber, [
              'waiting-for:address-pr-feedback',
              'agent:in-progress',
            ]);
            workerLogger.info(
              { issueNumber: item.issueNumber },
              '#1130: cleared waiting-for:address-pr-feedback + agent:in-progress on 0-findings exit',
            );
          } catch (error) {
            workerLogger.warn(
              { error: String(error), issueNumber: item.issueNumber },
              '#1130: failed to clear labels on 0-findings exit — non-fatal',
            );
          }
          workerLogger.info(
            { prNumber },
            '#1130: no trusted external feedback findings — completing without seeding review loop',
          );
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

        // D-2 (FR-006): reset the remediation counter before seeding so a fresh
        // external ask gets the full remediation budget — thread resolution and
        // gate-label removal alone must NOT reset it.
        //
        // #1130 finding #1(c): this reset is only reached for genuinely-new
        // feedback. Re-enqueue of the SAME unaddressed feedback is blocked
        // upstream: on cap the monitor skips while `waiting-for:remediation-limit`
        // is present (finding #1(b)); on convergence the external threads are
        // resolved so the monitor sees nothing live (finding #1(a)). The worker
        // therefore reaches this line only when the operator cleared the gate or
        // a new/re-opened human thread changed the unresolved set — both correct
        // occasions to grant a fresh budget. The old runaway (reset-on-every-poll
        // for identical feedback) is unreachable.
        //
        // #1159 FR-001/FR-002a: a non-completing loop exit escalates to a
        // `failed:*` label instead of resolving threads, which previously slipped
        // past the monitor's gate skips and re-enqueued on every poll, wiping the
        // budget here each time. The blanket `failed:*` monitor skip
        // (pr-feedback-monitor-service.ts, FR-003) closes that last hole, so this
        // reset is now genuinely reached only on the two legitimate occasions.
        await clearReviewArtifact(checkoutPath, workflowId);
        await writeExternalFeedbackSeed(checkoutPath, workflowId, {
          version: 1,
          prNumber,
          seededAt: new Date().toISOString(),
          findings,
        });
        workerLogger.info(
          { prNumber, findingCount: findings.length },
          '#1130: seeded external feedback into the review→remediate loop',
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
      // remediation routing on the base-advance path.
      const md = (item.metadata ?? {}) as Record<string, unknown>;
      const rawResumeReason = md['resumeReason'];
      const resumeReason =
        rawResumeReason === 'base-advance'
          ? ('base-advance' as const)
          : rawResumeReason === 'merge-conflict-resolved'
            ? ('merge-conflict-resolved' as const)
            : undefined;
      const baseSha = typeof md['baseSha'] === 'string' ? (md['baseSha'] as string) : undefined;

      // #1131: explicit start-phase override on the merge-conflict resume path.
      // Labels do NOT reliably resolve to `review` after a resolution (a conflict
      // during `validate`, after `review` already ran, carries `completed:review`
      // and would resolve straight back to `validate`). So when the re-arm was a
      // scoped-`review` re-arm, honor its `startPhase` directly, bypassing the
      // label-derived result. Any other resumeReason/startPhase → label-derived.
      const effectiveStartPhase: WorkflowPhase =
        resumeReason === 'merge-conflict-resolved' && md['startPhase'] === 'review'
          ? 'review'
          : startPhase;
      const reviewScope =
        resumeReason === 'merge-conflict-resolved'
          ? (md['reviewScope'] as ReviewScope | undefined)
          : undefined;

      const context: WorkerContext = {
        workerId,
        jobId,
        item,
        startPhase: effectiveStartPhase,
        github,
        logger: workerLogger,
        signal: abortController.signal,
        checkoutPath,
        branch: resolvedBranch,
        issueUrl: `https://github.com/${item.owner}/${item.repo}/issues/${item.issueNumber}`,
        description,
        siblingWorkdirs,
        ...(resumeReason ? { resumeReason } : {}),
        ...(baseSha ? { baseSha } : {}),
        ...(reviewScope ? { reviewScope } : {}),
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

      const conversationLogger = featureDir
        ? new ConversationLogger(featureDir)
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
        checkoutPath, // #1051 FR-002: cwd for the pre-push guard's git ls-remote
        workflowId, // #1156 FR-006: sidecar key for the cross-run markedReadyByEngine flag
      );

      // #1125/#1156: ReviewPoster posts the engine review + resolves threads.
      // #1156 FR-004: the PR number is resolved live per call via a getter — the
      // PR often does not exist at construction time, so capturing it once here
      // (the pre-#1156 `prNumber: getPrNumber() ?? 0`) posted early rounds to PR #0.
      const reviewPoster = new ReviewPoster({
        github,
        owner: item.owner,
        repo: item.repo,
        getPrNumber: () => prManager.getPrNumber(),
        logger: workerLogger,
      });

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
      // #1121: pass reviewPhaseEnabled so the effective sequence excludes
      // `review` when the flag is off (byte-identical flag-OFF run).
      const phaseSequence = getPhaseSequence(item.workflowName, effectiveConfig.reviewPhaseEnabled);
      const phaseLoop = new PhaseLoop(workerLogger);

      // #1124: real review-phase executor. Spawns the CLI with an in-process
      // charter prompt, reads the agent-written findings sidecar, recomputes the
      // verdict engine-side, and persists the review artifact. The synchronous
      // remediateTrigger reads that artifact's verdict to drive the review↔remediate
      // seam in phase-loop. Inert when reviewPhaseEnabled is off (review is absent
      // from the effective sequence).
      const realReviewExecutor = new ReviewExecutor({
        agentLauncher: this.agentLauncher,
        config: effectiveConfig,
        settings: orchSettings,
        logger: workerLogger,
      });

      // #1130: on the address-pr-feedback route, wrap the real executor so the
      // first `review` round consumes the external-feedback seed (synthesizes a
      // changes-required findings artifact without a CLI spawn). Convergence
      // rounds — after the seed is consumed — delegate to the real executor.
      const reviewExecutor = item.command === 'address-pr-feedback'
        ? new SeedAwareReviewExecutor({ delegate: realReviewExecutor, logger: workerLogger })
        : realReviewExecutor;

      // #1128: real remediate-phase executor. Reads the open blocking findings
      // from the same review sidecar, builds an in-process remediation charter,
      // spawns the CLI to make the code changes, and bumps remediationCount on
      // every return path. Inert when reviewPhaseEnabled is off (remediate is
      // off-sequence and only reachable via the review↔remediate seam).
      const remediateExecutor = new RemediateExecutor({
        agentLauncher: this.agentLauncher,
        config: effectiveConfig,
        settings: orchSettings,
        logger: workerLogger,
      });

      const loopResult = await phaseLoop.executeLoop(context, effectiveConfig, {
        labelManager,
        stageCommentManager,
        gateChecker,
        cliSpawner,
        outputCapture,
        prManager,
        conversationLogger,
        jobEventEmitter: this.jobEventEmitter,
        reviewExecutor,
        remediateExecutor,
        settings: orchSettings,
        remediateTrigger: (ctx) =>
          readReviewArtifactSync(
            ctx.checkoutPath,
            `${ctx.item.owner}/${ctx.item.repo}#${ctx.item.issueNumber}`,
          )?.verdict === 'changes-required',
        // #1156/#1161 FR-001: the findings reader the #1125 review side-effect
        // block depends on (left undefined before #1156, permanently disabling the
        // block). Reads the canonical engine-written sidecar and returns it paired
        // with the resolved `blockingSeverity` (used only for the poster's
        // render-time severity projection — INV-P1). The round lives in
        // `artifact.round` (single-round-source, INV-C1). No bridge: the poster
        // now consumes the canonical `ReviewFinding[]` directly (#1161 collapse).
        readFindingsArtifact: async (ctx) => {
          const artifact = await readReviewArtifact(
            ctx.checkoutPath,
            `${ctx.item.owner}/${ctx.item.repo}#${ctx.item.issueNumber}`,
          );
          if (!artifact) return null;
          const { blockingSeverity } = resolveWorkflowOverrides(
            effectiveConfig,
            orchSettings,
            ctx.item.workflowName,
          ).review;
          return { artifact, blockingSeverity };
        },
        ...(this.failureFingerprintTracker ? { failureFingerprintTracker: this.failureFingerprintTracker } : {}),
        ...(this.phaseTracker ? { phaseTracker: this.phaseTracker } : {}),
        reviewPoster,
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

          // #1130 finding #1(a): on the address-pr-feedback route, the shared
          // loop just converged (verdict clean → PR ready). The external human
          // threads that seeded it are still unresolved; resolve them here so the
          // monitor's next poll sees no live external feedback and does not
          // re-enqueue (the convergence half of the runaway fix — the cap half is
          // the monitor's waiting-for:remediation-limit skip). Best-effort: any
          // failure is swallowed by the resolver so the completed workflow stands.
          if (item.command === 'address-pr-feedback') {
            const feedbackMeta = item.metadata as PrFeedbackMetadata | undefined;
            const reviewThreadIds = feedbackMeta?.reviewThreadIds ?? [];
            const prNumber = feedbackMeta?.prNumber;
            if (prNumber && reviewThreadIds.length > 0) {
              let headShortSha = '<unknown>';
              try {
                headShortSha = (await github.getCurrentCommitSha()).slice(0, 7);
              } catch {
                // decoration only — leave the placeholder
              }
              await resolveExternalFeedbackThreads({
                github,
                owner: item.owner,
                repo: item.repo,
                prNumber,
                rootCommentIds: reviewThreadIds,
                headShortSha,
                logger: workerLogger,
              });
            }
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
