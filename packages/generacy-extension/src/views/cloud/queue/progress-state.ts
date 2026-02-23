/**
 * Job progress state manager.
 * Handles full snapshot replacement and tracks which phases should be expanded
 * in the detail webview. Designed for incremental merge extension (phase/step events).
 */
import type { JobProgress, WorkflowPhaseEventData, WorkflowStepEventData } from '../../../api/types';

/**
 * Manages the mutable progress state for a single job.
 * Supports snapshot replacement and tracks expanded phase IDs
 * for the detail webview's expand/collapse UI.
 */
export class JobProgressState {
  private progress: JobProgress | null = null;
  private expandedPhases: Set<string> = new Set();

  /**
   * Replace entire progress state with a full snapshot.
   * Recalculates the expanded phases set — only the currently running phase is expanded.
   */
  applySnapshot(progress: JobProgress): void {
    this.progress = progress;
    this.recalculateExpandedPhases();
  }

  /**
   * Reset the progress state to empty.
   * Used when switching to a different job.
   */
  reset(): void {
    this.progress = null;
    this.expandedPhases = new Set();
  }

  /**
   * Returns the current progress state, or null if no snapshot has been applied.
   */
  getProgress(): JobProgress | null {
    return this.progress;
  }

  /**
   * Returns the set of phase IDs that should be expanded in the webview.
   * Used for initial render and after snapshot replacement.
   */
  getExpandedPhases(): Set<string> {
    return this.expandedPhases;
  }

  /**
   * Merge an incremental phase event into the current state.
   * Updates the phase's status, timestamps, and error fields.
   * If the phase started running, updates `currentPhaseIndex`.
   * Ignores events for unknown phases (waits for next snapshot to reconcile).
   */
  applyPhaseEvent(event: WorkflowPhaseEventData): void {
    if (!this.progress) {
      return;
    }

    const phase = this.progress.phases.find((p) => p.id === event.phase.id);
    if (!phase) {
      return;
    }

    phase.status = event.phase.status;
    phase.startedAt = event.phase.startedAt;
    phase.completedAt = event.phase.completedAt;
    phase.durationMs = event.phase.durationMs;
    phase.error = event.phase.error;

    if (event.phase.status === 'running') {
      this.progress.currentPhaseIndex = event.phaseIndex;
      // Smart expand: collapse all other phases, expand only the now-running one
      this.expandedPhases.clear();
      this.expandedPhases.add(phase.id);
    } else {
      // Phase completed/failed/skipped — collapse it
      this.expandedPhases.delete(phase.id);
    }

    this.progress.updatedAt = new Date().toISOString();
  }

  /**
   * Merge an incremental step event into the current state.
   * Finds the step within the target phase and updates its fields.
   * Ignores events for unknown phases or steps (waits for next snapshot).
   */
  applyStepEvent(event: WorkflowStepEventData): void {
    if (!this.progress) {
      return;
    }

    const phase = this.progress.phases.find((p) => p.id === event.phaseId);
    if (!phase) {
      return;
    }

    const step = phase.steps.find((s) => s.id === event.step.id);
    if (!step) {
      return;
    }

    step.status = event.step.status;
    step.startedAt = event.step.startedAt;
    step.completedAt = event.step.completedAt;
    step.durationMs = event.step.durationMs;
    step.output = event.step.output;
    step.error = event.step.error;

    this.progress.updatedAt = new Date().toISOString();
  }

  /**
   * Recalculate the expanded phases set from the current progress state.
   * - Running phases are expanded (live view)
   * - Failed phases are expanded (so users immediately see error details)
   * - All other phases are collapsed
   */
  private recalculateExpandedPhases(): void {
    this.expandedPhases = new Set();
    if (!this.progress) {
      return;
    }
    for (const phase of this.progress.phases) {
      if (phase.status === 'running' || phase.status === 'failed') {
        this.expandedPhases.add(phase.id);
      }
    }
  }
}
