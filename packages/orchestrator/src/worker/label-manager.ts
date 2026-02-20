import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { WorkflowPhase, Logger } from './types.js';

/**
 * Manages label transitions on GitHub issues throughout the worker's phase loop.
 *
 * Each phase transition updates labels to reflect the current workflow state:
 * - `phase:<name>` — the phase currently being executed
 * - `completed:<name>` — a phase that finished successfully
 * - `waiting-for:<gate>` — the workflow is paused at a review gate
 * - `agent:paused` — the agent is waiting for human input
 * - `agent:error` — the agent encountered an error
 * - `agent:in-progress` — the agent is actively processing
 */
export class LabelManager {
  constructor(
    private readonly github: GitHubClient,
    private readonly owner: string,
    private readonly repo: string,
    private readonly issueNumber: number,
    private readonly logger: Logger,
  ) {}

  /**
   * Called when a phase begins execution.
   *
   * Adds `phase:<current>` label and removes any previous `phase:*` labels.
   */
  async onPhaseStart(phase: WorkflowPhase): Promise<void> {
    await this.retryWithBackoff(async () => {
      const currentLabels = await this.getCurrentPhaseLabels();
      const phaseLabel = `phase:${phase}`;

      // Remove any existing phase labels that aren't the new one
      const labelsToRemove = currentLabels.filter((l) => l !== phaseLabel);
      if (labelsToRemove.length > 0) {
        this.logger.info(
          { labels: labelsToRemove, issue: this.issueNumber },
          `Removing previous phase labels: ${labelsToRemove.join(', ')}`,
        );
        await this.github.removeLabels(this.owner, this.repo, this.issueNumber, labelsToRemove);
      }

      // Add the new phase label
      this.logger.info(
        { label: phaseLabel, issue: this.issueNumber },
        `Adding phase label: ${phaseLabel}`,
      );
      await this.github.addLabels(this.owner, this.repo, this.issueNumber, [phaseLabel]);
    });
  }

  /**
   * Called when a phase completes successfully.
   *
   * Adds `completed:<current>` label and removes `phase:<current>` label.
   */
  async onPhaseComplete(phase: WorkflowPhase): Promise<void> {
    await this.retryWithBackoff(async () => {
      const phaseLabel = `phase:${phase}`;
      const completedLabel = `completed:${phase}`;

      this.logger.info(
        { phase, issue: this.issueNumber },
        `Phase complete: removing ${phaseLabel}, adding ${completedLabel}`,
      );

      await this.github.removeLabels(this.owner, this.repo, this.issueNumber, [phaseLabel]);
      await this.github.addLabels(this.owner, this.repo, this.issueNumber, [completedLabel]);
    });
  }

  /**
   * Called when a gate is hit and the workflow must pause for human review.
   *
   * Adds `waiting-for:<gate>` and `agent:paused` labels, removes `phase:<current>`.
   */
  async onGateHit(phase: WorkflowPhase, gateLabel: string): Promise<void> {
    await this.retryWithBackoff(async () => {
      const phaseLabel = `phase:${phase}`;

      this.logger.info(
        { phase, gateLabel, issue: this.issueNumber },
        `Gate hit: removing ${phaseLabel}, adding ${gateLabel} and agent:paused`,
      );

      await this.github.removeLabels(this.owner, this.repo, this.issueNumber, [phaseLabel]);
      await this.github.addLabels(this.owner, this.repo, this.issueNumber, [
        gateLabel,
        'agent:paused',
      ]);
    });
  }

  /**
   * Called when an error occurs during phase execution.
   *
   * Adds `agent:error` label and removes `phase:<current>`.
   */
  async onError(phase: WorkflowPhase): Promise<void> {
    await this.retryWithBackoff(async () => {
      const phaseLabel = `phase:${phase}`;

      this.logger.info(
        { phase, issue: this.issueNumber },
        `Error in phase: removing ${phaseLabel} and agent:in-progress, adding agent:error`,
      );

      await this.github.removeLabels(this.owner, this.repo, this.issueNumber, [
        phaseLabel,
        'agent:in-progress',
      ]);
      await this.github.addLabels(this.owner, this.repo, this.issueNumber, ['agent:error']);
    });
  }

  /**
   * Called when the entire workflow completes (all phases finished).
   *
   * Removes the `agent:in-progress` label.
   */
  async onWorkflowComplete(): Promise<void> {
    await this.retryWithBackoff(async () => {
      this.logger.info(
        { issue: this.issueNumber },
        'Workflow complete: removing agent:in-progress',
      );

      await this.github.removeLabels(this.owner, this.repo, this.issueNumber, [
        'agent:in-progress',
      ]);
    });
  }

  /**
   * Fetch current labels on the issue and return those matching the `phase:*` pattern.
   */
  private async getCurrentPhaseLabels(): Promise<string[]> {
    const issue = await this.github.getIssue(this.owner, this.repo, this.issueNumber);
    return issue.labels
      .map((label) => (typeof label === 'string' ? label : label.name))
      .filter((name) => name.startsWith('phase:'));
  }

  /**
   * Retry an async operation with exponential backoff.
   *
   * Attempts the operation up to 3 times with delays of 1000ms, 2000ms, and 4000ms
   * between attempts. The final attempt's error is re-thrown.
   */
  private async retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
    const maxAttempts = 3;
    const delays = [1000, 2000, 4000];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt === maxAttempts) {
          this.logger.error(
            { attempt, error: String(error), issue: this.issueNumber },
            `Label operation failed after ${maxAttempts} attempts`,
          );
          throw error;
        }

        const delay = delays[attempt - 1]!;
        this.logger.warn(
          { attempt, delay, error: String(error), issue: this.issueNumber },
          `Label operation failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`,
        );

        await this.sleep(delay);
      }
    }

    // Unreachable, but satisfies TypeScript
    throw new Error('retryWithBackoff: unexpected exit');
  }

  /**
   * Sleep for the given number of milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
