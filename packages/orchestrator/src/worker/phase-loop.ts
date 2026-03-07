import type { WorkerContext, PhaseResult, Logger, WorkflowPhase } from './types.js';
import { PHASE_SEQUENCE, PHASE_TO_COMMAND, PHASE_TO_STAGE } from './types.js';
import type { WorkerConfig } from './config.js';
import type { LabelManager } from './label-manager.js';
import type { StageCommentManager } from './stage-comment-manager.js';
import type { GateChecker } from './gate-checker.js';
import type { CliSpawner } from './cli-spawner.js';
import type { OutputCapture } from './output-capture.js';
import type { PrManager } from './pr-manager.js';
import { postClarifications, hasPendingClarifications, integrateClarificationAnswers } from './clarification-poster.js';

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
}

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
    const sequence = phaseSequence ?? PHASE_SEQUENCE;
    const { labelManager, stageCommentManager, gateChecker, cliSpawner, outputCapture, prManager } = deps;
    const results: PhaseResult[] = [];

    // Track session ID across phases for conversation resume.
    // When a CLI phase completes, its session ID is passed to the next phase
    // so Claude CLI can reuse the conversation (keeping MCP servers warm and
    // carrying forward accumulated context).
    let currentSessionId: string | undefined;

    // Find the starting index in the phase sequence
    const startIndex = sequence.indexOf(context.startPhase);
    if (startIndex === -1) {
      throw new Error(`Unknown starting phase: ${context.startPhase}`);
    }

    this.logger.info(
      { startPhase: context.startPhase, startIndex, totalPhases: sequence.length },
      'Starting phase loop',
    );

    // Track actual timestamps per phase
    const phaseTimestamps = new Map<WorkflowPhase, { startedAt: string; completedAt?: string }>();

    for (let i = startIndex; i < sequence.length; i++) {
      const phase = sequence[i]!;

      // Check abort signal before starting each phase
      if (context.signal.aborted) {
        this.logger.warn({ phase }, 'Abort signal detected, stopping phase loop');
        return { results, completed: false, lastPhase: phase, gateHit: false };
      }

      this.logger.info({ phase, index: i }, 'Starting phase');

      // Record phase start time
      phaseTimestamps.set(phase, { startedAt: new Date().toISOString() });

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

      // 3. Execute the phase
      let result: PhaseResult;
      try {
        if (PHASE_TO_COMMAND[phase] === null) {
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
              await stageCommentManager.updateStageComment({
                stage,
                status: 'error',
                phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'error'),
                startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
              });
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
          // CLI phase — spawn Claude CLI (resume previous session if available)
          result = await cliSpawner.spawnPhase(
            phase,
            {
              prompt: context.issueUrl,
              cwd: context.checkoutPath,
              env: { CLAUDE_HEADLESS: 'true' },
              timeoutMs: config.phaseTimeoutMs,
              signal: context.signal,
              resumeSessionId: currentSessionId,
            },
            outputCapture,
          );
        }
      } catch (error) {
        // Unexpected error during spawning
        this.logger.error(
          { phase, error: String(error) },
          'Unexpected error during phase execution',
        );
        await labelManager.onError(phase);
        await stageCommentManager.updateStageComment({
          stage,
          status: 'error',
          phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'error'),
          startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
        });
        throw error;
      }

      results.push(result);

      // 3b. Capture session ID for resume in subsequent phases
      if (result.sessionId) {
        if (!currentSessionId) {
          this.logger.info({ sessionId: result.sessionId, phase }, 'Captured initial session ID for conversation reuse');
        }
        currentSessionId = result.sessionId;
      }

      // 4. Handle phase failure
      if (!result.success) {
        this.logger.error(
          { phase, exitCode: result.exitCode, error: result.error?.message },
          'Phase failed',
        );
        await labelManager.onError(phase);
        await stageCommentManager.updateStageComment({
          stage,
          status: 'error',
          phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'error'),
          startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
        });
        return { results, completed: false, lastPhase: phase, gateHit: false };
      }

      // 5. Commit, push, and ensure draft PR exists (before marking complete)
      const { prUrl, hasChanges } = await prManager.commitPushAndEnsurePr(phase);
      if (prUrl) {
        context.prUrl = prUrl;
      }

      // 5b. Fail phases that require file changes but produced none
      if (PHASES_REQUIRING_CHANGES.has(phase) && !hasChanges) {
        this.logger.error(
          { phase },
          'Phase completed with exit code 0 but produced no file changes',
        );
        await labelManager.onError(phase);
        await stageCommentManager.updateStageComment({
          stage,
          status: 'error',
          phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'error'),
          startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
          prUrl: context.prUrl,
        });
        result.success = false;
        result.error = {
          message: `Phase "${phase}" succeeded but produced no file changes — expected code to be written`,
          stderr: '',
          phase,
        };
        return { results, completed: false, lastPhase: phase, gateHit: false };
      }

      // 5c. Mark phase as completed in labels
      await labelManager.onPhaseComplete(phase);

      // 6. Check for review gates
      const gate = gateChecker.checkGate(phase, context.item.workflowName, config);

      // Evaluate whether the gate should activate based on its condition
      let gateActive = false;
      if (gate) {
        if (gate.condition === 'always') {
          gateActive = true;
        } else if (gate.condition === 'on-questions') {
          // Defensive: integrate any GitHub answers into local clarifications.md
          // before checking for pending questions. The Claude CLI clarify command
          // should do this via manage_clarifications update_answer, but if it
          // doesn't, this ensures answers aren't lost and the gate passes.
          await integrateClarificationAnswers(context, this.logger);
          gateActive = hasPendingClarifications(context.checkoutPath, context.item.issueNumber);
          if (!gateActive) {
            this.logger.info(
              { phase, gateLabel: gate.gateLabel },
              'Gate condition "on-questions" not met (no pending clarifications) — skipping',
            );
          }
        }
      }

      if (gateActive && gate) {
        // Check if this gate is already satisfied (e.g., completed:clarification
        // was added before the workflow reached this point). The completed label
        // corresponds to the gate label suffix: waiting-for:X → completed:X.
        const gateSuffix = gate.gateLabel.replace(/^waiting-for:/, '');
        const completedLabel = `completed:${gateSuffix}`;
        const currentIssue = await context.github.getIssue(context.item.owner, context.item.repo, context.item.issueNumber);
        const currentLabels = currentIssue.labels.map((l) => typeof l === 'string' ? l : l.name);

        if (currentLabels.includes(completedLabel)) {
          this.logger.info(
            { phase, gateLabel: gate.gateLabel, completedLabel },
            'Gate already satisfied — skipping pause',
          );
        } else {
          this.logger.info(
            { phase, gateLabel: gate.gateLabel },
            'Gate hit, pausing workflow',
          );
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
