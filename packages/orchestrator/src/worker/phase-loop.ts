import type { WorkerContext, PhaseResult, Logger, WorkflowPhase, JobEventEmitter, PhaseAfterHandler, StageType, CommandExitEvidence } from './types.js';
import { PHASE_SEQUENCE, PHASE_TO_STAGE } from './types.js';
import { isTerminalLabelOpError, type TerminalLabelOpSite } from './terminal-label-op-error.js';
import type { WorkerConfig } from './config.js';
import { resolvePhaseTimeoutMs, resolveAgentForPhase } from './config.js';
import type { LabelManager } from './label-manager.js';
import type { StageCommentManager } from './stage-comment-manager.js';
import type { GateChecker } from './gate-checker.js';
import type { CliSpawner } from './cli-spawner.js';
import { DEFAULT_INSTALL_TIMEOUT_MS, DEFAULT_VALIDATE_TIMEOUT_MS } from './cli-spawner.js';
import type { OutputCapture } from './output-capture.js';
import type { PrManager } from './pr-manager.js';
import type { ValidateFixHandler } from './validate-fix-handler.js';
import type { ConversationLogger } from './conversation-logger.js';
import { postClarifications, hasPendingClarifications, integrateClarificationAnswers } from './clarification-poster.js';
import { buildSiblingPromptBlock } from './sibling-prompt.js';
import { checkSiblingReviews } from './sibling-review-checker.js';
import { EXCLUDED_PATH_PREFIXES, computeProductDiff, resolveBaseRef } from './product-diff.js';
import { boundOutputTail } from './output-tail.js';
import { synthesizeOutputTail } from './output-tail-synthesis.js';
import { performBaseMerge, resolveBaseBranch, type BaseMergeRunner } from './base-merge.js';
import { MERGE_CONFLICT_REMEDY } from './merge-conflict-remedy.js';
import { writePauseContext } from './pause-context.js';
import { randomUUID } from 'node:crypto';

/** Phases that MUST produce file changes to be considered successful. */
const PHASES_REQUIRING_CHANGES: ReadonlySet<WorkflowPhase> = new Set(['implement']);

/**
 * Dependencies injected into the PhaseLoop.
 */
export interface PhaseLoopDeps {
  labelManager: LabelManager;
  stageCommentManager: StageCommentManager;
  gateChecker: GateChecker;
  cliSpawner: CliSpawner;
  outputCapture: OutputCapture;
  prManager: PrManager;
  conversationLogger?: ConversationLogger;
  /** Optional callback for emitting job lifecycle events */
  jobEventEmitter?: JobEventEmitter;
  /** Optional callbacks invoked after each phase completes, before gate check */
  phaseAfterHandlers?: PhaseAfterHandler[];
  /**
   * Injected base-merge runner used by the pre-phase base-merge hook (#864).
   * Defaults to `performBaseMerge` from `./base-merge.js`. Tests inject a fake
   * that returns canned `BaseMergeResult` values without exercising real git.
   */
  baseMergeRunner?: BaseMergeRunner;
  /**
   * Bounded validate-fix cycle handler (#892). Invoked on the validate failure
   * path ONLY when `context.resumeReason === 'base-advance'` — first-time reds
   * continue to route through `LabelManager.onError('validate')` (D7).
   */
  validateFixHandler?: ValidateFixHandler;
}

/**
 * Discriminator for `PhaseLoopResult` (#889 additive extension).
 *
 * - `'completed'`: legacy shape (`completed: true`).
 * - `'gate-hit'`: legacy shape (`gateHit: true`).
 * - `'phase-failed'`: legacy shape (a phase produced `!result.success`).
 * - `'failed-terminal'`: NEW in #889 — a `LabelManager` retry exhausted and
 *   raised `TerminalLabelOpError`. `failureMetadata` carries the alert payload.
 */
export type PhaseLoopStatus = 'completed' | 'gate-hit' | 'phase-failed' | 'failed-terminal';

/**
 * Result of a complete phase loop execution.
 */
export interface PhaseLoopResult {
  /** All phase results from the loop */
  results: PhaseResult[];
  /** Whether the entire loop completed successfully */
  completed: boolean;
  /** The last phase that was executed */
  lastPhase: string;
  /** Whether the loop was stopped by a gate */
  gateHit: boolean;
  /**
   * #889 additive discriminator. Backwards-compatible with existing readers
   * of `completed` / `gateHit` / `lastPhase`.
   */
  status?: PhaseLoopStatus;
  /**
   * Only populated when `status === 'failed-terminal'` (#889). Copied from the
   * thrown `TerminalLabelOpError` and forwarded to the dispatcher.
   */
  failureMetadata?: {
    site: TerminalLabelOpSite;
    labelOp: string;
    ghStderr: string;
  };
}

/**
 * Iterates through workflow phases from the starting phase to completion.
 *
 * For each phase the loop:
 * 1. Updates labels to reflect the current phase
 * 2. Spawns the Claude CLI (or runs the validate command)
 * 3. Marks the phase as completed
 * 4. Checks for review gates
 * 5. Updates the stage comment with progress
 *
 * The loop stops on:
 * - Gate hit (workflow paused for human review)
 * - Phase failure (error)
 * - Abort signal
 * - All phases completed
 */
export class PhaseLoop {
  constructor(private readonly logger: Logger) {}

  /**
   * Execute the phase loop from the starting phase through to completion.
   *
   * @param phaseSequence - Optional workflow-specific phase sequence.
   *   Defaults to the global PHASE_SEQUENCE for backward compatibility.
   */
  async executeLoop(
    context: WorkerContext,
    config: WorkerConfig,
    deps: PhaseLoopDeps,
    phaseSequence?: WorkflowPhase[],
  ): Promise<PhaseLoopResult> {
    try {
      return await this.executeLoopInner(context, config, deps, phaseSequence);
    } catch (error) {
      // #889: LabelManager retry exhaustion. Translate the terminal error into
      // a `failed-terminal` PhaseLoopResult so the worker can surface a bounded
      // alert instead of re-throwing and crash-looping the queue.
      if (isTerminalLabelOpError(error)) {
        this.logger.error(
          {
            site: error.site,
            labelOp: error.labelOp,
            ghStderr: error.ghStderr,
          },
          'Phase loop caught TerminalLabelOpError — surfacing as failed-terminal',
        );
        return {
          results: [],
          completed: false,
          lastPhase: context.startPhase,
          gateHit: false,
          status: 'failed-terminal',
          failureMetadata: {
            site: error.site,
            labelOp: error.labelOp,
            ghStderr: error.ghStderr,
          },
        };
      }
      throw error;
    }
  }

  private async executeLoopInner(
    context: WorkerContext,
    config: WorkerConfig,
    deps: PhaseLoopDeps,
    phaseSequence?: WorkflowPhase[],
  ): Promise<PhaseLoopResult> {
    const sequence = phaseSequence ?? PHASE_SEQUENCE;
    const { labelManager, stageCommentManager, gateChecker, cliSpawner, outputCapture, prManager, conversationLogger, jobEventEmitter } = deps;
    const baseMergeRunner: BaseMergeRunner = deps.baseMergeRunner ?? performBaseMerge;
    const results: PhaseResult[] = [];

    // Mint a stable per-invocation runId used inside the failure-alert marker.
    // See specs/865-found-during-cockpit-v1/contracts/failure-alert-comment.md.
    const runId = randomUUID();

    // Track session ID across phases for conversation resume.
    // When a CLI phase completes, its session ID is passed to the next phase
    // so Claude CLI can reuse the conversation (keeping MCP servers warm and
    // carrying forward accumulated context).
    let currentSessionId: string | undefined;
    // #814: track the resolved provider + model across phases. `currentProvider`
    // gates the session-drop-on-provider-switch behavior (FR-011); `currentModel`
    // feeds the `agent.model.transition` log line on same-provider model change.
    let currentProvider: string | undefined;
    let currentModel: string | undefined;
    let implementRetryCount = 0;

    // Track last seen tasks_remaining for the implement increment guard.
    // Prevents infinite loops when no progress is made between increments.
    let lastTasksRemaining: number | undefined;

    // Find the starting index in the phase sequence
    const startIndex = sequence.indexOf(context.startPhase);
    if (startIndex === -1) {
      throw new Error(`Unknown starting phase: ${context.startPhase}`);
    }

    this.logger.info(
      { startPhase: context.startPhase, startIndex, totalPhases: sequence.length, runId },
      'Starting phase loop',
    );

    // Track actual timestamps per phase
    const phaseTimestamps = new Map<WorkflowPhase, { startedAt: string; completedAt?: string }>();

    for (let i = startIndex; i < sequence.length; i++) {
      const phase = sequence[i]!;

      // #914: per-iteration guard enforcing at-most-one pre-phase base-merge
      // per cycle. Block-scoped `let` inside the for-body is load-bearing —
      // it re-initializes on every iteration (including retry re-entries via
      // `i--; continue;`), keeping the retry semantics of Q3-A intact.
      let hasBaseMergedThisCycle = false;

      // Check abort signal before starting each phase
      if (context.signal.aborted) {
        this.logger.warn({ phase }, 'Abort signal detected, stopping phase loop');
        return { results, completed: false, lastPhase: phase, gateHit: false };
      }

      this.logger.info({ phase, index: i }, 'Starting phase');

      // Emit job:phase_changed before any label/comment updates
      jobEventEmitter?.('job:phase_changed', {
        jobId: context.jobId,
        workflowName: context.item.workflowName,
        owner: context.item.owner,
        repo: context.item.repo,
        issueNumber: context.item.issueNumber,
        status: 'active',
        currentStep: phase,
      });

      // Record phase start time (only on first entry — preserve across retries for total wall-clock time)
      if (!phaseTimestamps.has(phase)) {
        phaseTimestamps.set(phase, { startedAt: new Date().toISOString() });
      }

      // 1. Update labels: mark this phase as active
      await labelManager.onPhaseStart(phase);

      // 2. Update stage comment to show phase in progress
      const stage = PHASE_TO_STAGE[phase];
      await stageCommentManager.updateStageComment({
        stage,
        status: 'in_progress',
        phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps),
        startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
      });

      // 2b. Pre-phase base-merge (#864) — implement, pre-validate, validate only.
      // On {ok:false} the workflow pauses with the merge-conflict gate; on {ok:true}
      // execution proceeds normally. Non-conflict git failures throw and are caught
      // in the same try/catch as phase execution below.
      //
      // #914: the `hasBaseMergedThisCycle` guard enforces the at-most-once
      // invariant. Symmetry immunization per Q5-B — even the implement path,
      // which historically never double-merged, is wrapped so a future edit
      // cannot reintroduce the buggy shape by accident.
      if (phase === 'implement' && !hasBaseMergedThisCycle) {
        const baseMergeOutcome = await this.runPreImplementBaseMerge(
          context,
          deps,
          baseMergeRunner,
          phase,
          stage,
          sequence,
          startIndex,
          i,
          phaseTimestamps,
        );
        if (baseMergeOutcome !== undefined) {
          return baseMergeOutcome;
        }
        hasBaseMergedThisCycle = true;
      }

      // 3. Execute the phase
      let result: PhaseResult;
      try {
        if (phase === 'validate') {
          // 3a. Pre-phase base-merge for the validate cycle (#864, #914) —
          // ephemeral. Runs ONCE before the first spawned command of the
          // cycle (install, or validate itself if no preValidateCommand).
          // The second between-install-and-validate call site (#864 original)
          // was deleted in #914 — its `git reset --hard` + `git clean -fd`
          // was destroying the freshly-installed toolchain (snappoll#4).
          if (!hasBaseMergedThisCycle) {
            const preValidateMergeOutcome = await this.runPreValidateBaseMerge(
              context,
              deps,
              baseMergeRunner,
              phase,
              stage,
              sequence,
              startIndex,
              i,
              phaseTimestamps,
            );
            if (preValidateMergeOutcome !== undefined) {
              return preValidateMergeOutcome;
            }
            hasBaseMergedThisCycle = true;
          }

          // Pre-validate: install dependencies if configured
          if (config.preValidateCommand) {
            const installResult = await cliSpawner.runPreValidateInstall(
              context.checkoutPath,
              config.preValidateCommand,
              context.signal,
            );
            if (!installResult.success) {
              this.logger.error(
                { phase, error: installResult.error?.message },
                'Pre-validate install failed',
              );
              results.push(installResult);
              await labelManager.onError(phase);
              const evidence = this.buildErrorEvidence(
                config.preValidateCommand,
                installResult,
                DEFAULT_INSTALL_TIMEOUT_MS,
                undefined,
              );
              await stageCommentManager.updateStageComment({
                stage,
                status: 'error',
                phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'error'),
                startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
                errorEvidence: evidence,
              });
              await stageCommentManager.postFailureAlert({ stage, runId, phase, evidence });
              return { results, completed: false, lastPhase: phase, gateHit: false };
            }
          }

          // Validate phase — run test command
          result = await cliSpawner.runValidatePhase(
            context.checkoutPath,
            config.validateCommand,
            context.signal,
          );
        } else {
          // Set up conversation logger for this CLI phase
          if (conversationLogger) {
            conversationLogger.setPhase(phase, currentSessionId ?? '', undefined);
          }

          // CLI phase — spawn Claude CLI (resume previous session if available)
          const siblingBlock = buildSiblingPromptBlock(context.siblingWorkdirs ?? {});
          const prompt = siblingBlock
            ? `${siblingBlock}\n\n${context.issueUrl}`
            : context.issueUrl;
          const cliPhase = phase as Exclude<typeof phase, 'validate'>;

          // #814: resolve provider+model for this phase. Provider always defined
          // (built-in fallback). Model optional (undefined = no `--model` arg).
          const { provider: nextProvider, model: nextModel } = resolveAgentForPhase(
            config,
            context.item.workflowName,
            cliPhase,
          );

          // Drop session on provider switch (FR-011). Sessions are provider-scoped;
          // reusing one across providers would try to resume against a session ID
          // the new provider doesn't know.
          if (currentProvider !== undefined && currentProvider !== nextProvider) {
            this.logger.info(
              { phase: cliPhase, prevProvider: currentProvider, nextProvider },
              'Provider switch detected — dropping session for fresh start',
            );
            currentSessionId = undefined;
          }

          // Emit model-transition log line on same-provider model change (Q2→C).
          // Only meaningful when we actually saw a prior phase with the same
          // provider AND both models are defined (a switch from undefined→X or
          // X→undefined is not a "transition" — either the config just started
          // or just stopped naming a model).
          if (
            currentProvider === nextProvider &&
            currentModel !== undefined &&
            nextModel !== undefined &&
            currentModel !== nextModel
          ) {
            this.logger.info(
              { provider: nextProvider, prevModel: currentModel, nextModel },
              'agent.model.transition',
            );
          }

          const previousModel = currentProvider === nextProvider ? currentModel : undefined;

          result = await cliSpawner.spawnPhase(
            cliPhase,
            {
              prompt,
              cwd: context.checkoutPath,
              env: { CLAUDE_HEADLESS: 'true' },
              timeoutMs: resolvePhaseTimeoutMs(config, cliPhase),
              signal: context.signal,
              resumeSessionId: currentSessionId,
              siblingWorkdirs: context.siblingWorkdirs,
              provider: nextProvider,
              ...(nextModel !== undefined ? { model: nextModel } : {}),
              ...(previousModel !== undefined ? { previousModel } : {}),
            },
            outputCapture,
          );

          // Update trackers post-spawn so failures don't strand state.
          currentProvider = nextProvider;
          currentModel = nextModel;
        }
      } catch (error) {
        // Unexpected error during spawning
        this.logger.error(
          { phase, error: String(error) },
          'Unexpected error during phase execution',
        );
        await labelManager.onError(phase);
        const syntheticResult: PhaseResult = {
          phase,
          success: false,
          exitCode: 1,
          durationMs: 0,
          output: [],
          error: { message: String(error), output: '', phase },
        };
        const evidence = this.buildErrorEvidence(
          phase === 'validate' ? config.validateCommand : phase,
          syntheticResult,
          undefined,
          'spawn-error',
        );
        await stageCommentManager.updateStageComment({
          stage,
          status: 'error',
          phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'error'),
          startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
          errorEvidence: evidence,
        });
        await stageCommentManager.postFailureAlert({ stage, runId, phase, evidence });
        throw error;
      }

      results.push(result);

      // 3a-bis. Close conversation logger for this phase (flush + phase_complete entry)
      if (conversationLogger && phase !== 'validate') {
        try {
          await conversationLogger.close();
        } catch (err) {
          this.logger.warn(
            { phase, error: String(err) },
            'ConversationLogger.close() failed — continuing',
          );
        }
      }

      // 3b. Capture session ID for resume in subsequent phases
      if (result.sessionId) {
        if (!currentSessionId) {
          this.logger.info({ sessionId: result.sessionId, phase }, 'Captured initial session ID for conversation reuse');
        }
        currentSessionId = result.sessionId;
      }

      // 3c. Increment boundary: re-invoke implement with a fresh session if partial
      if (phase === 'implement' && result.success && result.implementResult?.partial) {
        const tasksRemaining = result.implementResult.tasks_remaining ?? 0;

        // Guard: fail if no progress made (prevents infinite loop)
        if (lastTasksRemaining !== undefined && tasksRemaining >= lastTasksRemaining) {
          this.logger.error(
            { phase, tasksRemaining, lastTasksRemaining },
            'Implement increment made no progress — failing to prevent infinite loop',
          );
          // FR-007: set result.error BEFORE evidence derivation so the alert
          // and stage-comment evidence blocks have diagnostic content.
          result.success = false;
          result.error = {
            message: 'Implement increment made no progress — aborting to prevent infinite loop',
            output: `no progress: tasks_remaining stayed at ${tasksRemaining} across two increments`,
            phase,
          };
          const evidence = this.buildErrorEvidence(
            'implement (no-progress guard)',
            result,
            undefined,
            'no-progress',
          );
          await labelManager.onError(phase);
          await stageCommentManager.updateStageComment({
            stage,
            status: 'error',
            phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'error'),
            startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
            prUrl: context.prUrl,
            errorEvidence: evidence,
          });
          await stageCommentManager.postFailureAlert({ stage, runId, phase, evidence });
          return { results, completed: false, lastPhase: phase, gateHit: false };
        }
        lastTasksRemaining = tasksRemaining;

        // Commit, push, and ensure PR with a WIP message
        const { prUrl: partialPrUrl } = await prManager.commitPushAndEnsurePr(phase, {
          message: `wip(speckit): implement increment for #${context.item.issueNumber} (${result.implementResult.tasks_completed ?? 0} tasks done, ${tasksRemaining} remaining)`,
        });
        if (partialPrUrl) context.prUrl = partialPrUrl;

        // Clear session for a fresh context window on next increment
        currentSessionId = undefined;

        // Update stage comment with incremental progress
        await stageCommentManager.updateStageComment({
          stage,
          status: 'in_progress',
          phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'in_progress'),
          startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
          prUrl: context.prUrl,
        });

        this.logger.info({ tasksRemaining }, 'Implement increment complete — re-invoking with fresh session');
        i--; // Re-run implement phase
        continue;
      }

      // Reset increment tracking when leaving the implement phase normally
      if (phase !== 'implement') {
        lastTasksRemaining = undefined;
      }

      // 4. Handle phase failure
      if (!result.success) {
        this.logger.error(
          { phase, exitCode: result.exitCode, error: result.error?.message },
          'Phase failed',
        );

        // Implement phase retry: commit partial progress and retry with a fresh session
        if (phase === 'implement') {
          const { hasChanges } = await prManager.commitPushAndEnsurePr(phase, {
            message: `wip(speckit): partial implement progress for #${context.item.issueNumber} (retry ${implementRetryCount + 1})`,
          });
          if (hasChanges && implementRetryCount < config.maxImplementRetries) {
            implementRetryCount++;
            currentSessionId = undefined;
            this.logger.warn(
              { phase, retry: implementRetryCount, maxRetries: config.maxImplementRetries },
              'Implement phase failed with partial progress — retrying with fresh session',
            );
            await stageCommentManager.updateStageComment({
              stage,
              status: 'in_progress',
              phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'in_progress'),
              startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
              prUrl: context.prUrl,
            });
            i--;
            continue;
          }
        }

        // #892: bounded validate-fix cycle. Fires ONLY on the resume-driven
        // validate re-run (structurally gated on WorkerContext.resumeReason
        // === 'base-advance'). First-time reds continue through onError.
        if (
          phase === 'validate'
          && context.resumeReason === 'base-advance'
          && deps.validateFixHandler
          && prManager.getPrNumber() !== undefined
        ) {
          try {
            // resolveBaseBranch returns `origin/<name>`; strip prefix to
            // match the base-branch string used in listOpenPullRequests results.
            const baseRefFull = await resolveBaseBranch(
              context.github,
              prManager,
              context.checkoutPath,
              context.item.owner,
              context.item.repo,
              this.logger,
            );
            const baseBranch = baseRefFull.startsWith('origin/')
              ? baseRefFull.slice('origin/'.length)
              : baseRefFull;
            await deps.validateFixHandler.handle(
              context.item,
              context.checkoutPath,
              { prNumber: prManager.getPrNumber()!, baseBranch },
              {
                stdout: result.capturedStdout ?? '',
                // #890 renamed `error.stderr` → `error.output` (merged tail);
                // fall back to it when the raw stderr buffer is empty.
                stderr: result.capturedStderr ?? result.error?.output ?? '',
                exitCode: result.exitCode,
              },
              context.github,
            );
          } catch (err) {
            this.logger.warn(
              { err: String(err), phase, issueNumber: context.item.issueNumber },
              'validate-fix handler threw — falling through to standard onError path',
            );
          }
        }

        await labelManager.onError(phase);
        const evidence = this.buildErrorEvidence(
          phase === 'validate' ? config.validateCommand : phase,
          result,
          phase === 'validate'
            ? DEFAULT_VALIDATE_TIMEOUT_MS
            : resolvePhaseTimeoutMs(config, phase as Exclude<WorkflowPhase, 'validate'>),
          undefined,
        );
        await stageCommentManager.updateStageComment({
          stage,
          status: 'error',
          phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'error'),
          startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
          errorEvidence: evidence,
        });
        await stageCommentManager.postFailureAlert({ stage, runId, phase, evidence });
        return { results, completed: false, lastPhase: phase, gateHit: false };
      }

      // 5. Commit, push, and ensure draft PR exists (before marking complete)
      const { prUrl, hasChanges } = await prManager.commitPushAndEnsurePr(phase);
      if (prUrl) {
        context.prUrl = prUrl;
      }

      // 5b. Fail phases that require product-code changes but produced none.
      // Compares the branch's cumulative diff against its PR base ref (or the
      // default branch when no PR yet) and rejects when every changed file lives
      // under EXCLUDED_PATH_PREFIXES. See specs/820-*.
      if (PHASES_REQUIRING_CHANGES.has(phase)) {
        let productFiles: string[];
        let changedFiles: string[];
        let baseRef: string;
        try {
          baseRef = await resolveBaseRef(
            context.github,
            prManager,
            context.item.owner,
            context.item.repo,
          );
          ({ productFiles, changedFiles } = await computeProductDiff(context.github, baseRef));
        } catch (err) {
          this.logger.error(
            { phase, err: String(err) },
            'product-diff computation threw — treating as detection failure',
          );
          await labelManager.onError(phase);
          result.success = false;
          result.error = {
            message: `Phase "${phase}" product-diff detection failed: ${String(err)}`,
            output: '',
            phase,
          };
          const evidence = this.buildErrorEvidence(
            phase === 'validate' ? config.validateCommand : phase,
            result,
            undefined,
            'product-diff-error',
          );
          await stageCommentManager.updateStageComment({
            stage,
            status: 'error',
            phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'error'),
            startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
            prUrl: context.prUrl,
            errorEvidence: evidence,
          });
          await stageCommentManager.postFailureAlert({ stage, runId, phase, evidence });
          return { results, completed: false, lastPhase: phase, gateHit: false };
        }

        if (productFiles.length === 0) {
          this.logger.error(
            { phase, baseRef, changedFiles, excluded: EXCLUDED_PATH_PREFIXES },
            'implement phase produced no product-code changes — all diff lives under excluded paths',
          );
          await labelManager.onError(phase);
          result.success = false;
          result.error = {
            message:
              `Phase "${phase}" produced no product-code changes — all changed files are under excluded prefixes ` +
              `[${EXCLUDED_PATH_PREFIXES.join(', ')}]. Implement must modify at least one non-excluded file.`,
            output: '',
            phase,
          };
          const evidence = this.buildErrorEvidence(
            phase === 'validate' ? config.validateCommand : phase,
            result,
            undefined,
            'no-product-code-changes',
          );
          await stageCommentManager.updateStageComment({
            stage,
            status: 'error',
            phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'error'),
            startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
            prUrl: context.prUrl,
            errorEvidence: evidence,
          });
          await stageCommentManager.postFailureAlert({ stage, runId, phase, evidence });
          return { results, completed: false, lastPhase: phase, gateHit: false };
        }
      }

      // 5c. Mark phase as completed in labels
      await labelManager.onPhaseComplete(phase);

      // 5d. Invoke phase:after handlers (post-commit, pre-gate)
      for (const handler of deps.phaseAfterHandlers ?? []) {
        await handler({ ...context, phase, commitResult: { prUrl, hasChanges } });
      }

      // 6. Check for review gates (multi-gate: iterate all matching gates for this phase)
      const gates = gateChecker.checkGates(phase, context.item.workflowName, config);

      // Fetch current issue labels once (shared across all gate evaluations)
      let currentLabels: string[] | undefined;

      for (const gate of gates) {
        // Evaluate whether the gate should activate based on its condition
        let gateActive = false;

        if (gate.condition === 'always') {
          gateActive = true;
        } else if (gate.condition === 'on-questions') {
          // Defensive: integrate any GitHub answers into local clarifications.md
          // before checking for pending questions.
          await integrateClarificationAnswers(context, this.logger);
          gateActive = hasPendingClarifications(context.checkoutPath, context.item.issueNumber);
          if (!gateActive) {
            this.logger.info(
              { phase, gateLabel: gate.gateLabel },
              'Gate condition "on-questions" not met (no pending clarifications) — skipping',
            );
          }
        } else if (gate.condition === 'on-sibling-review') {
          const reviewResult = await checkSiblingReviews(context.linkedPRs, this.logger);
          gateActive = !reviewResult.allApproved;
          if (gateActive) {
            this.logger.info(
              { phase, gateLabel: gate.gateLabel, statuses: reviewResult.statuses },
              'Gate condition "on-sibling-review" active — not all siblings approved',
            );
            // Flip all siblings to ready-for-review before pausing
            await prManager.markSiblingsReadyForReview(context.linkedPRs);
          } else {
            this.logger.info(
              { phase, gateLabel: gate.gateLabel },
              'Gate condition "on-sibling-review" satisfied — all siblings approved (or none linked)',
            );
          }
        }

        if (!gateActive) continue;

        // Check if this gate is already satisfied (e.g., completed:clarification
        // was added before the workflow reached this point). The completed label
        // corresponds to the gate label suffix: waiting-for:X → completed:X.
        const gateSuffix = gate.gateLabel.replace(/^waiting-for:/, '');
        const completedLabel = `completed:${gateSuffix}`;

        if (!currentLabels) {
          const currentIssue = await context.github.getIssue(context.item.owner, context.item.repo, context.item.issueNumber);
          currentLabels = currentIssue.labels.map((l) => typeof l === 'string' ? l : l.name);
        }

        if (currentLabels.includes(completedLabel)) {
          this.logger.info(
            { phase, gateLabel: gate.gateLabel, completedLabel },
            'Gate already satisfied — skipping pause',
          );
          continue;
        }

        // Gate is active and not already satisfied — pause the workflow
        this.logger.info(
          { phase, gateLabel: gate.gateLabel },
          'Gate hit, pausing workflow',
        );

        // Emit job:paused before gate label management
        jobEventEmitter?.('job:paused', {
          jobId: context.jobId,
          workflowName: context.item.workflowName,
          owner: context.item.owner,
          repo: context.item.repo,
          issueNumber: context.item.issueNumber,
          status: 'paused',
          currentStep: phase,
          gateLabel: gate.gateLabel,
        });

        await labelManager.onGateHit(phase, gate.gateLabel);

        // Post clarification questions to the issue when clarify gate is hit
        if (gate.gateLabel === 'waiting-for:clarification') {
          try {
            await postClarifications(context, this.logger);
          } catch (error) {
            this.logger.warn(
              { error: error instanceof Error ? error.message : String(error) },
              'Failed to post clarification questions — continuing gate flow',
            );
          }
        }

        // Update the result with gate info
        result.gateHit = {
          gateLabel: gate.gateLabel,
          reason: `Review gate "${gate.gateLabel}" activated after phase "${phase}"`,
        };

        // Record completion time before gate pause
        const ts = phaseTimestamps.get(phase);
        if (ts) ts.completedAt = new Date().toISOString();

        // Update stage comment showing gate hit
        await stageCommentManager.updateStageComment({
          stage,
          status: 'in_progress',
          phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'complete'),
          startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
          prUrl: context.prUrl,
        });

        return { results, completed: false, lastPhase: phase, gateHit: true };
      }

      // 7. Record phase completion time
      const phaseTs = phaseTimestamps.get(phase);
      if (phaseTs) phaseTs.completedAt = new Date().toISOString();

      // 8. Update stage comment showing phase complete
      const isLastPhaseInStage =
        i + 1 >= sequence.length || PHASE_TO_STAGE[sequence[i + 1]!] !== stage;

      await stageCommentManager.updateStageComment({
        stage,
        status: isLastPhaseInStage ? 'complete' : 'in_progress',
        phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'complete'),
        startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
        ...(isLastPhaseInStage ? { completedAt: new Date().toISOString() } : {}),
        prUrl: context.prUrl,
      });

      // Clear output buffer for next phase
      outputCapture.clear();
    }

    this.logger.info('Phase loop completed successfully — all phases done');
    return {
      results,
      completed: true,
      lastPhase: sequence[sequence.length - 1]!,
      gateHit: false,
    };
  }

  /**
   * Run the pre-implement base-merge (#864, committed). On conflict, pause the
   * workflow via `waiting-for:merge-conflicts` and return the pause result;
   * on clean merge, return `undefined` so the caller proceeds with phase execution.
   */
  private async runPreImplementBaseMerge(
    context: WorkerContext,
    deps: PhaseLoopDeps,
    baseMergeRunner: BaseMergeRunner,
    phase: WorkflowPhase,
    stage: StageType,
    sequence: WorkflowPhase[],
    startIndex: number,
    i: number,
    phaseTimestamps: Map<WorkflowPhase, { startedAt: string; completedAt?: string }>,
  ): Promise<PhaseLoopResult | undefined> {
    return this.runPrePhaseBaseMerge(
      context,
      deps,
      baseMergeRunner,
      phase,
      stage,
      sequence,
      startIndex,
      i,
      phaseTimestamps,
      { commit: true },
    );
  }

  /**
   * Run the pre-validate/validate base-merge (#864, ephemeral). Symmetric with
   * `runPreImplementBaseMerge` but `opts.commit === false` — the merge is left
   * as an un-committed merge in the workspace and MUST be discarded by the next
   * phase's reset-at-start (FR-006).
   */
  private async runPreValidateBaseMerge(
    context: WorkerContext,
    deps: PhaseLoopDeps,
    baseMergeRunner: BaseMergeRunner,
    phase: WorkflowPhase,
    stage: StageType,
    sequence: WorkflowPhase[],
    startIndex: number,
    i: number,
    phaseTimestamps: Map<WorkflowPhase, { startedAt: string; completedAt?: string }>,
  ): Promise<PhaseLoopResult | undefined> {
    return this.runPrePhaseBaseMerge(
      context,
      deps,
      baseMergeRunner,
      phase,
      stage,
      sequence,
      startIndex,
      i,
      phaseTimestamps,
      { commit: false },
    );
  }

  /**
   * Shared pre-phase base-merge implementation. Resolves the base ref, invokes
   * the runner, and (on conflict) pauses with `waiting-for:merge-conflicts` +
   * `errorEvidence.mergeConflict`. Reuses the existing gate-return path so
   * #849's paired resume-dedupe clear applies symmetrically.
   */
  private async runPrePhaseBaseMerge(
    context: WorkerContext,
    deps: PhaseLoopDeps,
    baseMergeRunner: BaseMergeRunner,
    phase: WorkflowPhase,
    stage: StageType,
    sequence: WorkflowPhase[],
    startIndex: number,
    i: number,
    phaseTimestamps: Map<WorkflowPhase, { startedAt: string; completedAt?: string }>,
    opts: { commit: boolean },
  ): Promise<PhaseLoopResult | undefined> {
    if (!context.branch) {
      this.logger.warn(
        { phase },
        'Skipping pre-phase base-merge — WorkerContext.branch not set',
      );
      return undefined;
    }

    const baseRef = await resolveBaseBranch(
      context.github,
      deps.prManager,
      context.checkoutPath,
      context.item.owner,
      context.item.repo,
      this.logger,
    );

    const mergeResult = await baseMergeRunner(
      context.checkoutPath,
      context.branch,
      baseRef,
      opts,
      this.logger,
    );

    if (mergeResult.ok) {
      this.logger.info(
        { phase, baseRef, commit: opts.commit, mergeSha: mergeResult.mergeSha },
        'Pre-phase base-merge succeeded',
      );
      return undefined;
    }

    // Conflict: pause with merge-conflict gate.
    const gateLabel = 'waiting-for:merge-conflicts';
    this.logger.warn(
      { phase, baseRef, conflictedPaths: mergeResult.conflictedPaths },
      'Pre-phase base-merge conflict — pausing workflow',
    );

    deps.jobEventEmitter?.('job:paused', {
      jobId: context.jobId,
      workflowName: context.item.workflowName,
      owner: context.item.owner,
      repo: context.item.repo,
      issueNumber: context.item.issueNumber,
      status: 'paused',
      currentStep: phase,
      gateLabel,
    });

    // #898 FR-011/FR-012: substitute the manual-remedy template with the
    // concrete branch / bare base / issue-ref for this pause. Keeps the
    // renderer content-agnostic — it just prints the strings as given.
    const bareBase = mergeResult.baseRef.replace(/^origin\//, '');
    const branchName = context.branch ?? '<branch>';
    const issueRef = `${context.item.owner}/${context.item.repo}#${context.item.issueNumber}`;
    const substitutedSteps = MERGE_CONFLICT_REMEDY.steps.map((step) =>
      step
        .replace(/<branch>/g, branchName)
        .replace(/<base>/g, bareBase)
        .replace(/<issue-ref>/g, issueRef),
    );

    await deps.stageCommentManager.updateStageComment({
      stage,
      status: 'in_progress',
      phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps),
      startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
      prUrl: context.prUrl,
      errorEvidence: {
        mergeConflict: {
          baseRef: mergeResult.baseRef,
          conflictedPaths: mergeResult.conflictedPaths,
          manualRemedy: {
            steps: substitutedSteps,
            warning: MERGE_CONFLICT_REMEDY.warning,
          },
        },
      },
    });

    // #902 FR-003: persist pause-context BEFORE applying the pause label.
    // The worker's MergeConflictHandler dispatch reads this to populate
    // `metadata.phase` — the single source of truth for the interrupted phase.
    // If the write throws, we do NOT apply the pause label — the pause simply
    // doesn't materialize, preventing the dead-park class.
    const workflowId = `${context.item.owner}/${context.item.repo}#${context.item.issueNumber}`;
    await writePauseContext(context.checkoutPath, workflowId, {
      phase,
      writtenAt: new Date().toISOString(),
      issueRef: workflowId,
    });

    await deps.labelManager.onGateHit(phase, gateLabel);

    return {
      results: [],
      completed: false,
      lastPhase: phase,
      gateHit: true,
    };
  }

  /**
   * Build the `errorEvidence` payload rendered inside the stage comment on
   * `status: 'error'` transitions. See specs/847-found-during-cockpit-v1/
   * contracts/failure-evidence-block.md for the derivation rules.
   */
  private buildErrorEvidence(
    command: string,
    result: PhaseResult,
    resolvedTimeoutMs?: number,
    classifier?: string,
  ): CommandExitEvidence {
    const message = result.error?.message ?? '';
    const exitDescriptor = classifier
      ? `failed post-exit: ${classifier} (process exit ${result.exitCode})`
      : message.includes('timed out') && resolvedTimeoutMs !== undefined
        ? `killed (SIGTERM) after ${resolvedTimeoutMs}ms`
        : message.includes('was aborted')
        ? 'aborted'
        : `exit ${result.exitCode}`;

    // Shell path: `error.output` is the ring-buffer tail (already merged).
    // CLI path: `error.output` is empty; synthesize from parsed `type: 'text'` chunks.
    // For synthetic PhaseResults (no-progress guard, product-diff failures, catch
    // block): `error.output` is set directly by the caller (still merged-shape).
    const rawOutput = result.error?.output ?? '';
    const outputTail = rawOutput.length > 0
      ? boundOutputTail(rawOutput)
      : synthesizeOutputTail(result.output);
    return {
      command,
      exitDescriptor,
      outputTail,
      ...(classifier ? { reason: message } : {}),
    };
  }

  /**
   * Build a phase progress array for stage comment updates.
   *
   * Uses actual tracked timestamps per phase rather than a single synthetic timestamp.
   */
  private buildPhaseProgress(
    sequence: WorkflowPhase[],
    startIndex: number,
    currentIndex: number,
    phaseTimestamps: Map<WorkflowPhase, { startedAt: string; completedAt?: string }>,
    currentStatus: 'in_progress' | 'complete' | 'error' = 'in_progress',
  ): { phase: WorkflowPhase; status: 'pending' | 'in_progress' | 'complete' | 'error'; startedAt?: string; completedAt?: string }[] {
    return sequence.map((phase, idx) => {
      const ts = phaseTimestamps.get(phase);

      if (idx < startIndex) {
        // Before the start — already complete from a prior run (no tracked timestamp)
        return { phase, status: 'complete' as const };
      }
      if (idx < currentIndex) {
        // Earlier in this run — completed
        return { phase, status: 'complete' as const, startedAt: ts?.startedAt, completedAt: ts?.completedAt };
      }
      if (idx === currentIndex) {
        // Current phase
        return { phase, status: currentStatus, startedAt: ts?.startedAt, ...(currentStatus === 'complete' || currentStatus === 'error' ? { completedAt: ts?.completedAt } : {}) };
      }
      // Future phase
      return { phase, status: 'pending' as const };
    });
  }
}
