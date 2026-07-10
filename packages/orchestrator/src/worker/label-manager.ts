import type { GitHubClient } from '@generacy-ai/workflow-engine';
import { WORKFLOW_LABELS } from '@generacy-ai/workflow-engine';
import type { WorkflowPhase, Logger } from './types.js';
import { TerminalLabelOpError, type TerminalLabelOpSite } from './terminal-label-op-error.js';

/**
 * Callback invoked from `onGateHit` after a pause label pair
 * (`waiting-for:<gate>` + `agent:paused`) has been successfully applied.
 * Used by callers wired to `PhaseTrackerService` to invalidate the paired
 * `resume:<gate>` dedupe key so a subsequent resume can pass through. See #849.
 */
export type ClearResumeDedupeCallback = (gate: string) => Promise<void>;

interface RetryContext {
  site: TerminalLabelOpSite;
  labelOp: string;
}

function extractStderr(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

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
  /**
   * Per-process cache of repos whose workflow labels have been ensured.
   * Key: `"owner/repo"`. Shared across every `LabelManager` instance in the
   * process — one boundary ensure-pass per repo per process lifetime.
   */
  private static readonly ensuredRepos = new Set<string>();

  /**
   * In-flight-Promise dedupe for concurrent first-callers on the same repo.
   * Key: `"owner/repo"`. Ensures the ensure-pass runs at most once
   * concurrently even if multiple issues in the same repo fire simultaneously.
   */
  private static readonly ensureInFlight = new Map<string, Promise<void>>();

  /** Test-only: reset the class-level memoization caches. */
  static resetEnsureCacheForTests(): void {
    LabelManager.ensuredRepos.clear();
    LabelManager.ensureInFlight.clear();
  }

  constructor(
    private readonly github: GitHubClient,
    private readonly owner: string,
    private readonly repo: string,
    private readonly issueNumber: number,
    private readonly logger: Logger,
    private readonly clearResumeDedupe?: ClearResumeDedupeCallback,
  ) {}

  /**
   * Called when a phase begins execution.
   *
   * Adds `phase:<current>` label and removes any previous `phase:*` labels.
   */
  async onPhaseStart(phase: WorkflowPhase): Promise<void> {
    const phaseLabel = `phase:${phase}`;
    await this.retryWithBackoff(async () => {
      await this.ensureRepoLabelsExist();
      const currentLabels = await this.getCurrentPhaseLabels();

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
    }, { site: 'phase-start', labelOp: `addLabels([${phaseLabel}])` });
  }

  /**
   * Called when a phase completes successfully.
   *
   * Adds `completed:<current>` label and removes `phase:<current>` label.
   */
  async onPhaseComplete(phase: WorkflowPhase): Promise<void> {
    const phaseLabel = `phase:${phase}`;
    const completedLabel = `completed:${phase}`;
    await this.retryWithBackoff(async () => {
      await this.ensureRepoLabelsExist();

      this.logger.info(
        { phase, issue: this.issueNumber },
        `Phase complete: removing ${phaseLabel}, adding ${completedLabel}`,
      );

      await this.github.removeLabels(this.owner, this.repo, this.issueNumber, [phaseLabel]);
      await this.github.addLabels(this.owner, this.repo, this.issueNumber, [completedLabel]);
    }, { site: 'phase-complete', labelOp: `addLabels([${completedLabel}])` });
  }

  /**
   * Called when a gate is hit and the workflow must pause for human review.
   *
   * Adds `waiting-for:<gate>` and `agent:paused` labels, removes `phase:<current>`.
   */
  async onGateHit(phase: WorkflowPhase, gateLabel: string): Promise<void> {
    const phaseLabel = `phase:${phase}`;
    const completedLabel = `completed:${phase}`;
    await this.retryWithBackoff(async () => {
      await this.ensureRepoLabelsExist();

      this.logger.info(
        { phase, gateLabel, issue: this.issueNumber },
        `Gate hit: removing ${phaseLabel} and ${completedLabel}, adding ${gateLabel} and agent:paused`,
      );

      await this.github.removeLabels(this.owner, this.repo, this.issueNumber, [
        phaseLabel,
        completedLabel,
      ]);
      await this.github.addLabels(this.owner, this.repo, this.issueNumber, [
        gateLabel,
        'agent:paused',
      ]);
    }, { site: 'gate-hit', labelOp: `addLabels([${gateLabel}, agent:paused])` });

    // #849: clear paired resume:<gate> dedupe on successful pause.
    // Best-effort — swallow failures so a Redis blip cannot fail the pause.
    if (this.clearResumeDedupe) {
      const gateSuffix = gateLabel.replace(/^waiting-for:/, '');
      try {
        await this.clearResumeDedupe(gateSuffix);
        this.logger.info(
          { phase, gateLabel, owner: this.owner, repo: this.repo, issueNumber: this.issueNumber },
          'Cleared paired resume dedupe on pause',
        );
      } catch (err) {
        this.logger.warn(
          {
            err: String(err),
            phase,
            gateLabel,
            owner: this.owner,
            repo: this.repo,
            issueNumber: this.issueNumber,
          },
          'Failed to clear paired resume dedupe on pause (non-fatal)',
        );
      }
    }
  }

  /**
   * Called when an error occurs during phase execution.
   *
   * Adds `agent:error` label and removes `phase:<current>`.
   */
  async onError(phase: WorkflowPhase): Promise<void> {
    const phaseLabel = `phase:${phase}`;
    const failedLabel = `failed:${phase}`;
    await this.retryWithBackoff(async () => {
      await this.ensureRepoLabelsExist();

      this.logger.info(
        { phase, issue: this.issueNumber },
        `Error in phase: removing ${phaseLabel} and agent:in-progress, adding ${failedLabel} and agent:error`,
      );

      await this.github.removeLabels(this.owner, this.repo, this.issueNumber, [
        phaseLabel,
        'agent:in-progress',
      ]);
      await this.github.addLabels(this.owner, this.repo, this.issueNumber, [failedLabel, 'agent:error']);
    }, { site: 'error', labelOp: `addLabels([${failedLabel}, agent:error])` });
  }

  /**
   * Called when the entire workflow completes (all phases finished).
   *
   * Removes the `agent:in-progress` label.
   */
  async onWorkflowComplete(): Promise<void> {
    await this.retryWithBackoff(async () => {
      await this.ensureRepoLabelsExist();

      this.logger.info(
        { issue: this.issueNumber },
        'Workflow complete: removing agent:in-progress',
      );

      await this.github.removeLabels(this.owner, this.repo, this.issueNumber, [
        'agent:in-progress',
      ]);
    }, { site: 'workflow-complete', labelOp: 'removeLabels([agent:in-progress])' });
  }

  /**
   * Called at the start of a resume (continue command) before the phase loop.
   *
   * Removes stale `waiting-for:*` and `agent:paused` labels that were set
   * when the workflow paused at a gate, and adds `agent:in-progress` to
   * reflect the active workflow state.
   */
  async onResumeStart(): Promise<void> {
    await this.retryWithBackoff(async () => {
      await this.ensureRepoLabelsExist();
      const issue = await this.github.getIssue(this.owner, this.repo, this.issueNumber);
      const currentLabels = issue.labels.map((l) =>
        typeof l === 'string' ? l : l.name,
      );

      const labelsToRemove = currentLabels.filter(
        (l) => l.startsWith('waiting-for:') || l === 'agent:paused',
      );

      // Also remove completed: labels for gates being resumed, so re-entering
      // the phase can re-activate the gate if needed (e.g., follow-up
      // clarification questions require another pause cycle).
      const gateSuffixes = currentLabels
        .filter((l) => l.startsWith('waiting-for:'))
        .map((l) => l.slice('waiting-for:'.length));
      for (const suffix of gateSuffixes) {
        const completedLabel = `completed:${suffix}`;
        if (currentLabels.includes(completedLabel) && !labelsToRemove.includes(completedLabel)) {
          labelsToRemove.push(completedLabel);
        }
      }

      if (labelsToRemove.length > 0) {
        this.logger.info(
          { labels: labelsToRemove, issue: this.issueNumber },
          'Resume: removing waiting-for, completed gate, and agent:paused labels',
        );
        await this.github.removeLabels(this.owner, this.repo, this.issueNumber, labelsToRemove);
      }

      // Add agent:in-progress to reflect active workflow state
      this.logger.info(
        { issue: this.issueNumber },
        'Resume: adding agent:in-progress label',
      );
      await this.github.addLabels(this.owner, this.repo, this.issueNumber, ['agent:in-progress']);
    }, { site: 'resume-start', labelOp: 'addLabels([agent:in-progress])' });
  }

  /**
   * Ensures `agent:in-progress` and any lingering `phase:*` labels are removed.
   *
   * Designed to be called from `finally` blocks and reaper loops — this method
   * never throws. If the GitHub API call fails after retries, the error is logged
   * at `warn` level and swallowed.
   *
   * Safe to call when labels have already been removed (idempotent):
   * `removeLabels()` in `gh-cli.ts` checks for "not found" in stderr and
   * silently ignores it, so removing an already-absent label is a no-op.
   * This also means `onWorkflowComplete()` is idempotent — calling it when
   * `agent:in-progress` has already been removed will not throw.
   */
  async ensureCleanup(): Promise<void> {
    try {
      const currentLabels = await this.getCurrentPhaseLabels();
      const labelsToRemove = ['agent:in-progress', ...currentLabels];

      if (labelsToRemove.length > 0) {
        this.logger.info(
          { labels: labelsToRemove, issue: this.issueNumber },
          'Ensuring cleanup: removing agent:in-progress and phase labels',
        );
        await this.retryWithBackoff(async () => {
          await this.github.removeLabels(this.owner, this.repo, this.issueNumber, labelsToRemove);
        }, { site: 'error', labelOp: `removeLabels(${JSON.stringify(labelsToRemove)})` });
      }
    } catch (error) {
      // Never throw from cleanup — log and move on
      this.logger.warn(
        { error: String(error), issue: this.issueNumber },
        'Failed to ensure label cleanup (non-fatal)',
      );
    }
  }

  /**
   * Ensures every label in `WORKFLOW_LABELS` exists on the target repo.
   *
   * Memoized per-process, keyed on `"owner/repo"`. First caller on a given
   * repo runs the pass; concurrent callers await the shared in-flight Promise;
   * subsequent callers return immediately. This is the load-bearing safety net
   * that catches labels not proactively provisioned by `LabelSyncService`.
   */
  private async ensureRepoLabelsExist(): Promise<void> {
    const key = `${this.owner}/${this.repo}`;
    if (LabelManager.ensuredRepos.has(key)) return;

    const inFlight = LabelManager.ensureInFlight.get(key);
    if (inFlight) {
      await inFlight;
      return;
    }

    const promise = (async () => {
      const existing = await this.github.listLabels(this.owner, this.repo);
      const existingNames = new Set(existing.map((l) => l.name));
      const missing = WORKFLOW_LABELS.filter((l) => !existingNames.has(l.name));

      for (const label of missing) {
        try {
          await this.github.createLabel(
            this.owner,
            this.repo,
            label.name,
            label.color,
            label.description,
          );
          this.logger.info(
            { label: label.name, owner: this.owner, repo: this.repo },
            'Created missing workflow label',
          );
        } catch (err) {
          // Create-race with a sibling worker on the same repo is expected and
          // safe — the label exists after our attempt regardless of who wrote it.
          this.logger.warn(
            {
              label: label.name,
              owner: this.owner,
              repo: this.repo,
              err: String(err),
            },
            'Failed to create workflow label (non-fatal, may already exist)',
          );
        }
      }
    })();

    LabelManager.ensureInFlight.set(key, promise);
    try {
      await promise;
      LabelManager.ensuredRepos.add(key);
    } finally {
      LabelManager.ensureInFlight.delete(key);
    }
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
   * between attempts. On final-attempt failure, throws `TerminalLabelOpError`
   * carrying the `{ site, labelOp, ghStderr, cause }` context so callers can
   * translate to `WorkerResult.status === 'failed-terminal'` without releasing
   * the item back to the queue (#889 crash-loop fix).
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    context: RetryContext,
  ): Promise<T> {
    const maxAttempts = 3;
    const delays = [1000, 2000, 4000];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt === maxAttempts) {
          this.logger.error(
            { attempt, error: String(error), issue: this.issueNumber, site: context.site, labelOp: context.labelOp },
            `Label operation failed after ${maxAttempts} attempts`,
          );
          throw new TerminalLabelOpError({
            site: context.site,
            labelOp: context.labelOp,
            ghStderr: extractStderr(error),
            cause: error,
          });
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
