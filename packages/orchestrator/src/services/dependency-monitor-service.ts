/**
 * #1211 T010 — Poll-based monitor that re-arms blocked implement phases when all
 * dependency refs are closed.
 *
 * Per poll cycle, per repo, per issue carrying `waiting-for:dependencies`:
 *   1. Read newest block marker comment → parse fenced JSON refs.
 *   2. `getIssueRefState` per ref.
 *   3. All closed ⇒ re-arm (post comment + apply label + enqueue continue).
 *   4. Any open/undeterminable ⇒ hold.
 *
 * In-memory `refFailures` map tracks per-ref read failures; at 3 consecutive
 * failures, an escalation comment is posted (deduped per block cycle).
 *
 * Contract: {@link specs/1211-problem-clarify-phase-answer/contracts/sentinel-and-gate-protocol.md} §5
 */
import {
  type GitHubClientFactory,
  type Comment,
  type IssueRefState,
} from '@generacy-ai/workflow-engine';
import type {
  QueueManager,
  QueueItem,
} from '../types/monitor.js';
import type { RepositoryConfig, PrMonitorConfig } from '../config/schema.js';
import type { Logger } from '../worker/types.js';
import {
  parseBlockCommentRefs,
  findNewestBlockComment,
  findNewestErrorComment,
  buildReArmComment,
  buildErrorComment,
  formatCanonicalRef,
  type DependencyRef,
} from '../worker/dependency-block.js';

const WAITING_FOR_DEPENDENCIES_LABEL = 'waiting-for:dependencies';
const COMPLETED_DEPENDENCIES_LABEL = 'completed:dependencies';
const ESCALATION_FAILURE_COUNT = 3;

// =============================================================================
// In-memory failure tracker
// =============================================================================

/**
 * Per-ref read-failure counter. Keyed by canonical ref string.
 * Success resets to 0; at ESCALATION_FAILURE_COUNT the monitor posts an error
 * comment and holds the gate.
 */
class RefFailureTracker {
  private readonly failures = new Map<string, number>();

  recordSuccess(refKey: string): void {
    this.failures.delete(refKey);
  }

  recordFailure(refKey: string): number {
    const next = (this.failures.get(refKey) ?? 0) + 1;
    this.failures.set(refKey, next);
    return next;
  }

  atEscalation(refKey: string): boolean {
    return (this.failures.get(refKey) ?? 0) >= ESCALATION_FAILURE_COUNT;
  }

  clear(): void {
    this.failures.clear();
  }
}

// =============================================================================
// Service
// =============================================================================

export class DependencyMonitorService {
  private readonly logger: Logger;
  private readonly createClient: GitHubClientFactory;
  private readonly queueManager: QueueManager;
  private readonly repositories: RepositoryConfig[];
  private readonly pollIntervalMs: number;
  private readonly maxConcurrentPolls: number;
  private readonly refFailures = new RefFailureTracker();
  private abortController: AbortController | null = null;
  private isPolling = false;

  constructor(
    logger: Logger,
    createClient: GitHubClientFactory,
    queueManager: QueueManager,
    config: PrMonitorConfig,
    repositories: RepositoryConfig[],
  ) {
    this.logger = logger;
    this.createClient = createClient;
    this.queueManager = queueManager;
    this.repositories = repositories;
    this.pollIntervalMs = config.pollIntervalMs;
    this.maxConcurrentPolls = config.maxConcurrentPolls;
  }

  // ==========================================================================
  // Polling
  // ==========================================================================

  async startPolling(): Promise<void> {
    if (this.isPolling) {
      this.logger.warn('Dependency monitor polling already running');
      return;
    }

    const ac = new AbortController();
    this.abortController = ac;
    this.isPolling = true;
    this.logger.info(
      { intervalMs: this.pollIntervalMs, repos: this.repositories.length },
      'Starting dependency monitor polling',
    );

    while (!ac.signal.aborted) {
      try {
        await this.poll();
      } catch (error) {
        this.logger.error(
          { err: error },
          'Error during dependency monitor poll cycle',
        );
      }

      await this.sleep(this.pollIntervalMs, ac.signal);
    }

    this.isPolling = false;
    this.logger.info('Dependency monitor polling loop stopped');
  }

  stopPolling(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.logger.info('Dependency monitor polling stop requested');
    }
  }

  async poll(): Promise<void> {
    if (this.repositories.length === 0) return;

    const semaphore = new Semaphore(this.maxConcurrentPolls);
    const pollTasks = this.repositories.map(({ owner, repo }) =>
      semaphore.acquire().then(async (release) => {
        try {
          await this.pollRepo(owner, repo);
        } finally {
          release();
        }
      }),
    );

    await Promise.allSettled(pollTasks);
  }

  // ==========================================================================
  // Per-repo polling
  // ==========================================================================

  private async pollRepo(owner: string, repo: string): Promise<void> {
    const client = this.createClient();

    let allIssues;
    try {
      allIssues = await client.listIssuesWithLabel(
        owner,
        repo,
        WAITING_FOR_DEPENDENCIES_LABEL,
      );
    } catch (error) {
      this.logger.warn(
        { err: String(error), owner, repo },
        'Error polling repository for dependency-blocked issues',
      );
      return;
    }

    if (allIssues.length === 0) {
      this.logger.debug(
        { owner, repo },
        'No dependency-blocked issues found this cycle',
      );
      return;
    }

    this.logger.info(
      { owner, repo, count: allIssues.length },
      'Dependency-blocked issues found',
    );

    for (const issue of allIssues) {
      try {
        await this.evaluateIssue(owner, repo, issue.number);
      } catch (err) {
        this.logger.warn(
          { err: String(err), owner, repo, issueNumber: issue.number },
          'Error evaluating dependency-blocked issue — continuing to next',
        );
      }
    }
  }

  // ==========================================================================
  // Issue evaluation (contract §5)
  // ==========================================================================

  /**
   * Evaluate a single dependency-blocked issue: read newest block marker,
   * check each ref, and re-arm if all closed.
   */
  private async evaluateIssue(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<void> {
    const client = this.createClient();

    // Step 1: Read newest block marker comment → parse refs
    let comments: Comment[];
    try {
      comments = await client.getIssueComments(owner, repo, issueNumber);
    } catch (err) {
      this.logger.warn(
        { err: String(err), owner, repo, issueNumber },
        'Failed to fetch comments for dependency-blocked issue — skipping',
      );
      return;
    }

    const blockComment = findNewestBlockComment(comments);
    if (!blockComment) {
      this.logger.debug(
        { owner, repo, issueNumber },
        'No block marker comment found on dependency-blocked issue — skipping',
      );
      return;
    }

    const refStrings = parseBlockCommentRefs(blockComment.body ?? '');
    if (!refStrings || refStrings.length === 0) {
      this.logger.warn(
        { owner, repo, issueNumber },
        'Block marker comment on dependency-blocked issue has no parseable refs — skipping',
      );
      return;
    }

    // Step 2: getIssueRefState per ref
    const results: Array<{
      ref: DependencyRef;
      state: 'open' | 'closed' | 'error';
      stateReason: string | null;
      merged: boolean | null;
    }> = [];

    let allClosed = true;

    for (const refStr of refStrings) {
      const match = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)#(\d+)$/.exec(refStr);
      if (!match) {
        this.logger.warn({ refStr, issueNumber }, 'Unparseable canonical ref in block marker — dropped');
        continue;
      }

      const ref: DependencyRef = {
        owner: match[1]!,
        repo: match[2]!,
        number: Number(match[3]),
      };
      const refKey = formatCanonicalRef(ref);

      try {
        const state: IssueRefState = await client.getIssueRefState(
          ref.owner, ref.repo, ref.number,
        );
        this.refFailures.recordSuccess(refKey);

        if (state.state === 'closed') {
          results.push({
            ref,
            state: 'closed',
            stateReason: state.stateReason,
            merged: state.merged,
          });
        } else {
          results.push({
            ref,
            state: 'open',
            stateReason: state.stateReason,
            merged: state.merged,
          });
          allClosed = false;
        }
      } catch (err) {
        const consecutiveFailures = this.refFailures.recordFailure(refKey);
        this.logger.warn(
          { err: String(err), refKey, consecutiveFailures, owner, repo, issueNumber },
          'Failed to read dependency ref state',
        );

        results.push({ ref, state: 'error', stateReason: null, merged: null });
        allClosed = false;

        // Step 2a: Escalation at 3 consecutive failures
        if (consecutiveFailures >= ESCALATION_FAILURE_COUNT && !this.hasRecentErrorComment(comments, refKey)) {
          try {
            const errorBody = buildErrorComment(ref, consecutiveFailures, String(err));
            await client.addIssueComment(owner, repo, issueNumber, errorBody);
          } catch (commentErr) {
            this.logger.warn(
              { err: String(commentErr), refKey, issueNumber },
              'Failed to post dependency-block error comment (non-fatal)',
            );
          }
        }
      }
    }

    if (results.length === 0) {
      this.logger.debug(
        { owner, repo, issueNumber },
        'No valid dependency refs found — holding gate',
      );
      return;
    }

    // Step 4: Any ref open or error ⇒ hold
    if (!allClosed) {
      this.logger.debug(
        { owner, repo, issueNumber, results: results.map(r => `${formatCanonicalRef(r.ref)}:${r.state}`) },
        'Not all dependency refs closed — holding gate',
      );
      return;
    }

    // Step 3: All refs closed ⇒ re-arm
    this.logger.info(
      { owner, repo, issueNumber },
      'All dependency refs closed — re-arming',
    );

    // Step 3a: Post re-arm comment (⚠ flags per Q3=C)
    try {
      const closedResults = results.map(r => ({
        ref: r.ref,
        state: 'closed' as const,
        stateReason: r.stateReason,
        merged: r.merged,
      }));
      const reArmBody = buildReArmComment(closedResults);
      await client.addIssueComment(owner, repo, issueNumber, reArmBody);
    } catch (err) {
      this.logger.warn(
        { err: String(err), owner, repo, issueNumber },
        'Failed to post re-arm comment (non-fatal)',
      );
    }

    // Step 3b: Apply completed:dependencies while gate labels are still present
    try {
      await client.addLabels(owner, repo, issueNumber, [COMPLETED_DEPENDENCIES_LABEL]);
    } catch (err) {
      this.logger.warn(
        { err: String(err), owner, repo, issueNumber },
        'Failed to apply completed:dependencies label (non-fatal)',
      );
    }

    // Step 3c: Enqueue continue (primary resume path)
    // Look for workflow label among existing labels
    let workflowName = 'speckit-feature';
    try {
      const issueDetail = await client.getIssue(owner, repo, issueNumber);
      const wfLabel = issueDetail.labels.find((l: { name: string }) => l.name.startsWith('workflow:'));
      if (wfLabel) {
        workflowName = wfLabel.name.slice('workflow:'.length);
      }
    } catch {
      // Default to speckit-feature
    }

    const queueItem: QueueItem = {
      owner,
      repo,
      issueNumber,
      workflowName,
      command: 'continue',
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
      metadata: {},
      queueReason: 'resume',
    };

    const enqueued = await this.queueManager.enqueueIfAbsent(queueItem);
    if (enqueued) {
      this.logger.info(
        { owner, repo, issueNumber },
        'Dependency-blocked issue re-armed — continue enqueued',
      );
    } else {
      this.logger.debug(
        { owner, repo, issueNumber },
        'Dependency-blocked issue already in queue — enqueue skipped',
      );
    }
  }

  // ==========================================================================
  // Escalation dedup
  // ==========================================================================

  /**
   * Check whether an error comment for the given ref already exists in the
   * current block cycle (i.e. newer than the newest block marker). Returns true
   * if a matching error comment exists, so the caller can skip posting another.
   */
  private hasRecentErrorComment(comments: Comment[], refKey: string): boolean {
    const newestBlock = findNewestBlockComment(comments);
    const blockTime = newestBlock ? new Date(newestBlock.created_at).getTime() : 0;

    const errorComment = findNewestErrorComment(comments);
    if (!errorComment) return false;

    const errorTime = new Date(errorComment.created_at).getTime();
    if (errorTime <= blockTime) return false;

    // Check that the comment body mentions this specific ref
    return errorComment.body?.includes(refKey) ?? false;
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/**
 * Simple semaphore for bounded concurrency. Copy of the clarification-answer
 * monitor's helper — deliberately duplicated to keep the two monitors
 * shape-parallel.
 */
class Semaphore {
  private count: number;
  private waiting: Array<() => void> = [];

  constructor(max: number) {
    this.count = max;
  }

  async acquire(): Promise<() => void> {
    if (this.count > 0) {
      this.count--;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.waiting.push(() => {
        this.count--;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.count++;
    const next = this.waiting.shift();
    if (next) next();
  }
}