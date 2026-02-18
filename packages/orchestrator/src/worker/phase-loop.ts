import type { WorkerContext, PhaseResult, Logger, WorkflowPhase } from './types.js';
import { PHASE_SEQUENCE, PHASE_TO_COMMAND, PHASE_TO_STAGE } from './types.js';
import type { WorkerConfig } from './config.js';
import type { LabelManager } from './label-manager.js';
import type { StageCommentManager } from './stage-comment-manager.js';
import type { GateChecker } from './gate-checker.js';
import type { CliSpawner } from './cli-spawner.js';
import type { OutputCapture } from './output-capture.js';

/**
 * Dependencies injected into the PhaseLoop.
 */
export interface PhaseLoopDeps {
  labelManager: LabelManager;
  stageCommentManager: StageCommentManager;
  gateChecker: GateChecker;
  cliSpawner: CliSpawner;
  outputCapture: OutputCapture;
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
   */
  async executeLoop(
    context: WorkerContext,
    config: WorkerConfig,
    deps: PhaseLoopDeps,
  ): Promise<PhaseLoopResult> {
    const { labelManager, stageCommentManager, gateChecker, cliSpawner, outputCapture } = deps;
    const results: PhaseResult[] = [];

    // Find the starting index in PHASE_SEQUENCE
    const startIndex = PHASE_SEQUENCE.indexOf(context.startPhase);
    if (startIndex === -1) {
      throw new Error(`Unknown starting phase: ${context.startPhase}`);
    }

    this.logger.info(
      { startPhase: context.startPhase, startIndex, totalPhases: PHASE_SEQUENCE.length },
      'Starting phase loop',
    );

    for (let i = startIndex; i < PHASE_SEQUENCE.length; i++) {
      const phase = PHASE_SEQUENCE[i]!;

      // Check abort signal before starting each phase
      if (context.signal.aborted) {
        this.logger.warn({ phase }, 'Abort signal detected, stopping phase loop');
        return { results, completed: false, lastPhase: phase, gateHit: false };
      }

      this.logger.info({ phase, index: i }, 'Starting phase');

      // 1. Update labels: mark this phase as active
      await labelManager.onPhaseStart(phase);

      // 2. Update stage comment to show phase in progress
      const stage = PHASE_TO_STAGE[phase];
      await stageCommentManager.updateStageComment({
        stage,
        status: 'in_progress',
        phases: this.buildPhaseProgress(startIndex, i),
        startedAt: new Date().toISOString(),
      });

      // 3. Execute the phase
      let result: PhaseResult;
      try {
        if (PHASE_TO_COMMAND[phase] === null) {
          // Validate phase — run test command
          result = await cliSpawner.runValidatePhase(
            context.checkoutPath,
            config.validateCommand,
            context.signal,
          );
        } else {
          // CLI phase — spawn Claude CLI
          result = await cliSpawner.spawnPhase(
            phase,
            {
              prompt: context.issueUrl,
              cwd: context.checkoutPath,
              env: {},
              maxTurns: config.maxTurns,
              timeoutMs: config.phaseTimeoutMs,
              signal: context.signal,
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
          phases: this.buildPhaseProgress(startIndex, i, 'error'),
          startedAt: new Date().toISOString(),
        });
        throw error;
      }

      results.push(result);

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
          phases: this.buildPhaseProgress(startIndex, i, 'error'),
          startedAt: new Date().toISOString(),
        });
        return { results, completed: false, lastPhase: phase, gateHit: false };
      }

      // 5. Mark phase as completed in labels
      await labelManager.onPhaseComplete(phase);

      // 6. Check for review gates
      const gate = gateChecker.checkGate(phase, context.item.workflowName, config);
      if (gate && gate.condition === 'always') {
        this.logger.info(
          { phase, gateLabel: gate.gateLabel },
          'Gate hit, pausing workflow',
        );
        await labelManager.onGateHit(phase, gate.gateLabel);

        // Update the result with gate info
        result.gateHit = {
          gateLabel: gate.gateLabel,
          reason: `Review gate "${gate.gateLabel}" activated after phase "${phase}"`,
        };

        // Update stage comment showing gate hit
        await stageCommentManager.updateStageComment({
          stage,
          status: 'in_progress',
          phases: this.buildPhaseProgress(startIndex, i, 'complete'),
          startedAt: new Date().toISOString(),
        });

        return { results, completed: false, lastPhase: phase, gateHit: true };
      }

      // 7. Update stage comment showing phase complete
      const isLastPhaseInStage =
        i + 1 >= PHASE_SEQUENCE.length || PHASE_TO_STAGE[PHASE_SEQUENCE[i + 1]!] !== stage;

      await stageCommentManager.updateStageComment({
        stage,
        status: isLastPhaseInStage ? 'complete' : 'in_progress',
        phases: this.buildPhaseProgress(startIndex, i, 'complete'),
        startedAt: new Date().toISOString(),
        ...(isLastPhaseInStage ? { completedAt: new Date().toISOString() } : {}),
      });

      // Clear output buffer for next phase
      outputCapture.clear();
    }

    this.logger.info('Phase loop completed successfully — all phases done');
    return {
      results,
      completed: true,
      lastPhase: PHASE_SEQUENCE[PHASE_SEQUENCE.length - 1]!,
      gateHit: false,
    };
  }

  /**
   * Build a phase progress array for stage comment updates.
   */
  private buildPhaseProgress(
    startIndex: number,
    currentIndex: number,
    currentStatus: 'in_progress' | 'complete' | 'error' = 'in_progress',
  ): { phase: WorkflowPhase; status: 'pending' | 'in_progress' | 'complete' | 'error'; startedAt?: string; completedAt?: string }[] {
    const now = new Date().toISOString();
    return PHASE_SEQUENCE.map((phase, idx) => {
      if (idx < startIndex) {
        // Before the start — already complete from a prior run
        return { phase, status: 'complete' as const, completedAt: now };
      }
      if (idx < currentIndex) {
        // Earlier in this run — completed
        return { phase, status: 'complete' as const, startedAt: now, completedAt: now };
      }
      if (idx === currentIndex) {
        // Current phase
        return { phase, status: currentStatus, startedAt: now };
      }
      // Future phase
      return { phase, status: 'pending' as const };
    });
  }
}
