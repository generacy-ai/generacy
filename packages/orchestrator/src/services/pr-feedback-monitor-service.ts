import {
  GhAuthError,
  isTrustedCommentAuthor,
  type GitHubClient,
  type GitHubClientFactory,
  type TrustReason,
} from '@generacy-ai/workflow-engine';
import { JitTokenError } from '@generacy-ai/control-plane';
import type {
  MonitorState,
  QueueManager,
  QueueItem,
  PrReviewEvent,
  PrFeedbackMetadata,
} from '../types/monitor.js';
import type { RepositoryConfig, PrMonitorConfig } from '../config/schema.js';
import { PrLinker, type PrLinkInput } from '../worker/pr-linker.js';
import type { Logger } from '../worker/types.js';
import type { AuthHealthSink } from './label-monitor-service.js';
import { decideAdaptivePoll } from './adaptive-poll-controller.js';

/**
 * #869 / FR-004 idempotency marker embedded in bot-authored top-level PR
 * comments. Grep-checked against `gh pr view --json comments` before posting
 * to guarantee one notice per zero-trusted episode.
 */
const UNTRUSTED_NOTICE_MARKER = '<!-- generacy:pr-feedback-untrusted-notice -->';

export interface PrFeedbackMonitorOptions {
  repositories: RepositoryConfig[];
  pollIntervalMs: number;
  adaptivePolling: boolean;
  maxConcurrentPolls: number;
}

const WAITING_FOR_PR_FEEDBACK_LABEL = 'waiting-for:address-pr-feedback';
const MIN_POLL_INTERVAL_MS = 10000;
/**
 * Adaptive polling divisor for PR feedback monitor.
 * Per US4: "Polling interval decreases by 50%" → divide by 2.
 * This differs from LabelMonitorService which uses ADAPTIVE_DIVISOR = 3.
 */
const ADAPTIVE_DIVISOR = 2;

/**
 * PR feedback monitor service that detects unresolved review comments
 * on PRs linked to orchestrated issues and triggers the feedback-addressing flow.
 *
 * Uses a hybrid webhook + polling architecture mirroring LabelMonitorService.
 */
export class PrFeedbackMonitorService {
  private readonly logger: Logger;
  private readonly createClient: GitHubClientFactory;
  private readonly tokenProvider?: () => Promise<string | undefined>;
  private readonly queueManager: QueueManager;
  private readonly options: PrFeedbackMonitorOptions;
  private readonly prLinker: PrLinker;
  private readonly clusterGithubUsername: string | undefined;
  private readonly authHealth: AuthHealthSink;
  private readonly githubAppCredentialId: string | undefined;
  private abortController: AbortController | null = null;

  // #861: state-transition tracking for zero-unresolved skip logging. Key is
  // `${owner}/${repo}#${prNumber}`. Never evicted (open PR set is bounded).
  private lastUnresolvedThreadCount: Map<string, number> = new Map();

  // #869 / FR-004: transition-edge tracking for zero-trusted notice posting.
  // Keyed as `${owner}/${repo}#${prNumber}`. Not persisted; monitor restart
  // re-triggers the notice, which is idempotency-safe via the marker grep.
  private lastZeroTrustedState: Map<string, boolean> = new Map();

  private state: MonitorState;

  constructor(
    logger: Logger,
    createClient: GitHubClientFactory,
    queueManager: QueueManager,
    config: PrMonitorConfig,
    repositories: RepositoryConfig[],
    clusterGithubUsername?: string,
    tokenProvider?: () => Promise<string | undefined>,
    authHealth?: AuthHealthSink,
    githubAppCredentialId?: string,
    webhooksConfigured: boolean = false,
  ) {
    this.logger = logger;
    this.createClient = createClient;
    this.tokenProvider = tokenProvider;
    this.queueManager = queueManager;
    this.clusterGithubUsername = clusterGithubUsername;
    this.authHealth = authHealth ?? { recordResult: () => undefined };
    this.githubAppCredentialId = githubAppCredentialId;
    this.options = {
      repositories,
      pollIntervalMs: config.pollIntervalMs,
      adaptivePolling: config.adaptivePolling,
      maxConcurrentPolls: config.maxConcurrentPolls,
    };
    this.prLinker = new PrLinker(logger);

    this.state = {
      isPolling: false,
      webhookHealthy: true,
      lastWebhookEvent: null,
      currentPollIntervalMs: config.pollIntervalMs,
      basePollIntervalMs: config.pollIntervalMs,
      webhooksConfigured,
    };
  }

  // ==========================================================================
  // PR Review Event Processing
  // ==========================================================================

  /**
   * Process a PR review event: link PR to issue, check for unresolved threads,
   * deduplicate, and enqueue feedback-addressing work.
   *
   * Shared by both webhook and polling paths.
   *
   * @returns true if feedback was enqueued, false if skipped or duplicate
   */
  async processPrReviewEvent(event: PrReviewEvent): Promise<boolean> {
    const { owner, repo, prNumber, prBody, branchName, source } = event;

    this.logger.info(
      { owner, repo, prNumber, source },
      `Processing PR review event from ${source}`,
    );

    const client = this.createClient(undefined, this.tokenProvider);

    // 1. Link PR to orchestrated issue
    const prInput: PrLinkInput = {
      number: prNumber,
      body: prBody,
      head: { ref: branchName },
    };

    const link = await this.prLinker.linkPrToIssue(client, owner, repo, prInput);
    if (!link) {
      this.logger.debug(
        { owner, repo, prNumber },
        'PR not linked to an orchestrated issue — skipping',
      );
      return false;
    }

    const { issueNumber, linkMethod, assignees } = link;

    // 2. Assignee check — skip PR feedback for issues not assigned to this cluster
    //    Uses assignees returned by PrLinker to avoid a duplicate getIssue() call
    if (this.clusterGithubUsername) {
      if (assignees.length === 0) {
        this.logger.warn(
          { owner, repo, issueNumber, prNumber },
          'Skipping PR feedback: linked issue has no assignees',
        );
        return false;
      }
      if (!assignees.includes(this.clusterGithubUsername)) {
        this.logger.debug(
          { owner, repo, issueNumber, prNumber, assignees },
          'Skipping PR feedback: linked issue not assigned to this cluster',
        );
        return false;
      }
      if (assignees.length > 1) {
        this.logger.warn(
          { owner, repo, issueNumber, assignees },
          'Issue has multiple assignees — may be processed by multiple clusters',
        );
      }
    }

    // 3. Fetch review threads via GraphQL and filter for unresolved threads.
    // #861: replaces the REST-comment-based path — REST never returned
    // `.resolved`, so the previous filter always matched nothing.
    // #869 / FR-005: trust-filter each unresolved thread's comments BEFORE
    // enqueue. Zero-trusted PRs skip enqueue and emit the FR-003 warn +
    // FR-004 top-level notice.
    let unresolvedThreadIds: number[];
    let totalUnresolvedThreads: number;
    let untrustedCommentSkips: Array<{
      commentId: number;
      author: string;
      authorAssociation: string | undefined;
      reason: TrustReason;
      viewerDidAuthor: boolean | undefined;
    }>;
    let totalThreads: number;
    try {
      const threads = await client.getPRReviewThreads(owner, repo, prNumber);
      totalThreads = threads.length;
      const unresolvedThreads = threads.filter(t => !t.isResolved);
      totalUnresolvedThreads = unresolvedThreads.length;

      const botLogin = process.env['CLUSTER_GITHUB_USERNAME'] ?? process.env['GH_USERNAME'];
      const trustedIds: number[] = [];
      const skips: typeof untrustedCommentSkips = [];

      for (const thread of unresolvedThreads) {
        let threadHasTrusted = false;
        for (const c of thread.comments) {
          const decision = isTrustedCommentAuthor(c, 'pr-feedback', {
            logger: this.logger,
            ...(botLogin ? { botLogin } : {}),
          });
          if (decision.trusted) {
            threadHasTrusted = true;
          } else {
            skips.push({
              commentId: c.id,
              author: c.author,
              authorAssociation: c.authorAssociation,
              reason: decision.reason,
              viewerDidAuthor: c.viewerDidAuthor,
            });
          }
        }
        if (threadHasTrusted) {
          trustedIds.push(thread.rootCommentId);
        }
      }

      unresolvedThreadIds = trustedIds;
      untrustedCommentSkips = skips;
    } catch (error) {
      if (error instanceof GhAuthError) {
        if (this.githubAppCredentialId) {
          this.authHealth.recordResult(
            this.githubAppCredentialId,
            { ok: false, statusCode: error.statusCode },
          );
        }
        this.logger.error(
          { err: error, owner, repo, prNumber, statusCode: error.statusCode },
          'GraphQL review-threads call failed (auth)',
        );
        return false;
      }
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error), owner, repo, prNumber },
        'GraphQL review-threads call failed (transient)',
      );
      return false;
    }

    // Successful call — mark auth-health OK for this credential.
    if (this.githubAppCredentialId) {
      this.authHealth.recordResult(this.githubAppCredentialId, { ok: true });
    }

    const stateKey = `${owner}/${repo}#${prNumber}`;

    // Case C: no unresolved threads at all — reset both state maps.
    if (totalUnresolvedThreads === 0) {
      // #861 state-transition logging: `info` on transition, `debug` on
      // steady-state. Bootstrap (previous === undefined) counts as a transition.
      const previous = this.lastUnresolvedThreadCount.get(stateKey);
      const isTransition = previous === undefined || previous !== 0;
      const logFn = isTransition ? this.logger.info : this.logger.debug;
      logFn.call(
        this.logger,
        {
          owner, repo, prNumber, issueNumber,
          totalThreads,
          unresolvedThreads: 0,
          previousUnresolvedThreads: previous ?? null,
        },
        isTransition
          ? 'No unresolved review threads (state change)'
          : 'No unresolved review threads — skipping',
      );
      this.lastUnresolvedThreadCount.set(stateKey, 0);
      this.lastZeroTrustedState.set(stateKey, false);
      return false;
    }

    // Case B: unresolved threads exist, but zero of them are trust-live.
    // #869 / FR-002, FR-003, FR-004: skip enqueue, emit warn log naming the
    // untrusted skips, and post a top-level notice on the transition edge.
    if (unresolvedThreadIds.length === 0) {
      // #878 skip-warn shape: per-comment viewerDidAuthor replaces the
      // clusterIdentity / normalizedClusterIdentity / normalizedAuthor
      // fields from the #874 login-comparison scheme.
      this.logger.warn(
        {
          owner, repo, prNumber, issueNumber,
          totalUnresolvedThreads,
          untrustedCommentSkips: untrustedCommentSkips.map((s) => ({
            commentId: s.commentId,
            author: s.author,
            authorAssociation: s.authorAssociation,
            reason: s.reason,
            viewerDidAuthor: s.viewerDidAuthor ?? null,
          })),
        },
        'PR has unresolved threads but every comment author is untrusted',
      );

      const previousZeroTrusted = this.lastZeroTrustedState.get(stateKey);
      if (previousZeroTrusted !== true) {
        await this.maybePostUntrustedNotice(client, owner, repo, prNumber);
      }
      this.lastZeroTrustedState.set(stateKey, true);
      this.lastUnresolvedThreadCount.set(stateKey, totalUnresolvedThreads);
      return false;
    }

    // Case A: at least one thread is trust-live — proceed to enqueue.
    if (untrustedCommentSkips.length > 0) {
      this.logger.debug(
        { owner, repo, prNumber, issueNumber, untrustedCommentSkips },
        'Some unresolved comments were skipped by trust filter (mixed-trust PR)',
      );
    }
    this.lastZeroTrustedState.set(stateKey, false);

    // Case A tail (#883): before enqueue, check for any `blocked:*` label on
    // the linked issue. The handler adds `blocked:stuck-feedback-loop` when
    // its fix cycle can't advance; the operator removes the label to permit
    // another attempt. Any `blocked:*` prefix is the contract — no allow-list.
    let issueLabels: string[];
    try {
      issueLabels = await client.getIssueLabels(owner, repo, issueNumber);
    } catch (error) {
      this.logger.warn(
        { err: error, owner, repo, issueNumber },
        'Failed to fetch issue labels for blocked:* skip check — proceeding without skip',
      );
      issueLabels = [];
    }
    const blockedLabel = issueLabels.find(l => l.startsWith('blocked:'));
    if (blockedLabel) {
      this.logger.info(
        {
          owner, repo, prNumber, issueNumber,
          blockedLabel,
          unresolvedThreads: unresolvedThreadIds.length,
          reason: 'blocked-label-present',
        },
        'Skipping PR-feedback enqueue while blocked:* label is present',
      );
      // Idempotent-state hygiene: keep the transition-log map fresh so the
      // next non-blocked poll doesn't look like a fresh transition.
      this.lastUnresolvedThreadCount.set(stateKey, unresolvedThreadIds.length);
      return false;
    }

    this.logger.info(
      { owner, repo, prNumber, issueNumber, linkMethod, unresolvedCount: unresolvedThreadIds.length },
      `Found ${unresolvedThreadIds.length} unresolved review thread(s)`,
    );
    this.lastUnresolvedThreadCount.set(stateKey, unresolvedThreadIds.length);

    // 4. #879 / FR-010: add the waiting-for label idempotently BEFORE enqueue so
    // it survives an `enqueueIfAbsent → false` in-flight-collision drop. Label
    // presence = "feedback pending"; enqueue is work scheduling. Failure to
    // add is non-fatal warn.
    try {
      await client.addLabels(owner, repo, issueNumber, [WAITING_FOR_PR_FEEDBACK_LABEL]);
    } catch (error) {
      this.logger.warn(
        { err: error, owner, repo, issueNumber },
        'Failed to add waiting-for:address-pr-feedback label',
      );
    }

    // 5. Resolve workflow name from issue labels
    const workflowName = await this.resolveWorkflowName(owner, repo, issueNumber);

    // 6. Build queue item
    const metadata: PrFeedbackMetadata = {
      prNumber,
      reviewThreadIds: unresolvedThreadIds,
    };

    const queueItem: QueueItem = {
      owner,
      repo,
      issueNumber,
      workflowName,
      command: 'address-pr-feedback',
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
      metadata: metadata as unknown as Record<string, unknown>,
      queueReason: 'resume',
    };

    // 7. #879 / FR-001: atomic in-flight-checked enqueue. Replaces the pre-#879
    // `phaseTracker.tryMarkProcessed` SET-NX dedupe. Self-clearing by
    // construction: when the handler completes/fails/drops via
    // `QueueManager.complete()` / `.release()`, the itemKey leaves the
    // in-flight SET and the next trusted state re-enqueues on the following
    // poll — no TTL wait, no per-surface bookkeeping.
    const itemKey = `${owner}/${repo}#${issueNumber}`;
    const enqueued = await this.queueManager.enqueueIfAbsent(queueItem);
    if (!enqueued) {
      // FR-009: monitor-side context log paired with the adapter-level line.
      this.logger.info(
        { itemKey, reason: 'in-flight', prNumber, issueNumber, owner, repo },
        'Dropping PR-feedback enqueue (item already in flight)',
      );
      return false;
    }

    this.logger.info(
      { owner, repo, issueNumber, prNumber, command: queueItem.command },
      'PR feedback work enqueued',
    );

    return true;
  }

  // ==========================================================================
  // Zero-trusted notice posting (#869 / FR-004)
  // ==========================================================================

  /**
   * Post a single top-level PR comment notifying the operator that every
   * unresolved review-thread comment is currently untrusted. Idempotent via
   * the `UNTRUSTED_NOTICE_MARKER` grep against existing PR comments. Failures
   * to list or post comments are non-fatal — logged and swallowed so they
   * never break the poll cycle.
   */
  private async maybePostUntrustedNotice(
    client: GitHubClient,
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<void> {
    let existingComments: string[];
    try {
      existingComments = await client.listPrCommentBodies(owner, repo, prNumber);
    } catch (err) {
      this.logger.warn(
        { err: String(err), owner, repo, prNumber },
        'Failed to list PR comments for untrusted-notice idempotency check — skipping notice this cycle',
      );
      return;
    }

    if (existingComments.some(body => body.includes(UNTRUSTED_NOTICE_MARKER))) {
      this.logger.debug(
        { owner, repo, prNumber },
        'Untrusted-notice marker already present — skipping notice post',
      );
      return;
    }

    const body = [
      UNTRUSTED_NOTICE_MARKER,
      '',
      '⚠️ **Feedback requires a trusted author**',
      '',
      'This PR has unresolved review threads, but every comment author is currently',
      'classified as untrusted by the PR-feedback loop\'s trust filter (see #842).',
      '',
      'The loop will not automatically address this feedback until either:',
      '- A repository OWNER / MEMBER / COLLABORATOR replies to one of the threads, **or**',
      '- The cluster identity is configured to match one of the comment authors',
      '  (see the `CLUSTER_GITHUB_USERNAME` / `GH_USERNAME` chain).',
      '',
      'This is an automated notice from the PR-feedback monitor.',
    ].join('\n');

    try {
      await client.postPrComment(owner, repo, prNumber, body);
      this.logger.info(
        { owner, repo, prNumber },
        'Posted untrusted-feedback notice on PR (FR-004)',
      );
    } catch (err) {
      this.logger.warn(
        { err: String(err), owner, repo, prNumber },
        'Failed to post untrusted-feedback notice — will retry on next transition',
      );
    }
  }

  // ==========================================================================
  // Polling
  // ==========================================================================

  /**
   * Start the polling loop.
   */
  async startPolling(): Promise<void> {
    if (this.state.isPolling) {
      this.logger.warn('PR feedback polling already running');
      return;
    }

    const ac = new AbortController();
    this.abortController = ac;
    this.state.isPolling = true;
    this.logger.info(
      { intervalMs: this.state.currentPollIntervalMs, repos: this.options.repositories.length },
      'Starting PR feedback monitor polling',
    );

    while (!ac.signal.aborted) {
      try {
        await this.poll();
      } catch (error) {
        this.logger.error(
          { err: error },
          'Error during PR feedback poll cycle',
        );
      }

      // Update adaptive polling before sleeping
      if (this.options.adaptivePolling) {
        this.updateAdaptivePolling();
      }

      await this.sleep(this.state.currentPollIntervalMs, ac.signal);
    }

    this.state.isPolling = false;
    this.logger.info('PR feedback polling loop stopped');
  }

  /**
   * Stop the polling loop.
   */
  stopPolling(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.logger.info('PR feedback polling stop requested');
    }
  }

  /**
   * Run a single poll cycle across all watched repositories.
   * Lists open PRs in each repo, checks for unresolved review threads.
   */
  async poll(): Promise<void> {
    const repos = this.options.repositories;
    if (repos.length === 0) return;

    // Use semaphore pattern for concurrency limiting
    const semaphore = new Semaphore(this.options.maxConcurrentPolls);

    const pollTasks = repos.map(({ owner, repo }) =>
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

  /**
   * Poll a single repository for PRs with unresolved review threads.
   * Lists open PRs and processes each through the standard event flow.
   */
  private async pollRepo(owner: string, repo: string): Promise<void> {
    const client = this.createClient(undefined, this.tokenProvider);

    let openPRs;
    try {
      openPRs = await client.listOpenPullRequests(owner, repo);
      if (this.githubAppCredentialId) {
        this.authHealth.recordResult(this.githubAppCredentialId, { ok: true });
      }
    } catch (error) {
      if (error instanceof JitTokenError) {
        // JIT token fetch failed — provider already evicted cache and recorded
        // the failure. Skip this poll cycle so we never spawn `gh` with an
        // empty/ambient token. The next cycle will retry.
        this.logger.warn(
          { code: error.code, message: error.message, owner, repo },
          'JIT GitHub token refresh failed — skipping PR-feedback monitor cycle',
        );
        return;
      }
      if (error instanceof GhAuthError) {
        const credentialId = this.githubAppCredentialId;
        if (credentialId) {
          this.authHealth.recordResult(credentialId, { ok: false, statusCode: 401 });
        }
        this.logger.warn(
          { credentialId, statusCode: 401, owner, repo },
          'GitHub authentication failing — investigate credential refresh chain',
        );
        return;
      }
      if (this.isRateLimitError(error)) {
        this.logger.warn(
          { owner, repo },
          'GitHub API rate limit hit while listing open PRs — skipping repo this cycle',
        );
        return;
      }
      this.logger.error(
        { err: error, owner, repo },
        'Error polling repository for open PRs',
      );
      return;
    }

    // FR-015: When multiple PRs exist for the same issue, process only the
    // most recently updated PR. Use a lightweight pre-link pass (body/branch
    // parsing only, no API calls) to group PRs by candidate issue number.
    const prsToProcess = this.deduplicatePrsByIssue(owner, repo, openPRs);

    for (const pr of prsToProcess) {
      const event: PrReviewEvent = {
        owner,
        repo,
        prNumber: pr.number,
        prBody: pr.body ?? '',
        branchName: pr.head.ref,
        source: 'poll',
      };

      try {
        await this.processPrReviewEvent(event);
      } catch (error) {
        if (error instanceof JitTokenError) {
          this.logger.warn(
            { code: error.code, message: error.message, owner, repo, prNumber: pr.number },
            'JIT GitHub token refresh failed — stopping PR-feedback monitor cycle',
          );
          return;
        }
        if (error instanceof GhAuthError) {
          const credentialId = this.githubAppCredentialId;
          if (credentialId) {
            this.authHealth.recordResult(credentialId, { ok: false, statusCode: 401 });
          }
          this.logger.warn(
            { credentialId, statusCode: 401, owner, repo, prNumber: pr.number },
            'GitHub authentication failing — investigate credential refresh chain',
          );
          return;
        }
        if (this.isRateLimitError(error)) {
          this.logger.warn(
            { owner, repo, prNumber: pr.number },
            'GitHub API rate limit hit while processing PR — stopping repo poll',
          );
          return;
        }
        this.logger.error(
          { err: error, owner, repo, prNumber: pr.number },
          'Error processing PR during poll',
        );
      }
    }
  }

  /**
   * FR-015: Deduplicate PRs that link to the same issue, keeping only the
   * most recently updated PR per issue. Uses lightweight body/branch parsing
   * (no API calls) to determine candidate issue numbers.
   *
   * PRs that don't resolve to any issue number are kept as-is (they'll be
   * filtered out later by `processPrReviewEvent` when linking fails).
   */
  private deduplicatePrsByIssue(
    owner: string,
    repo: string,
    prs: Array<{ number: number; body: string; head: { ref: string }; updated_at: string }>,
  ): typeof prs {
    // Group PRs by candidate issue number
    const issueGroups = new Map<number, typeof prs>();
    const unlinked: typeof prs = [];

    for (const pr of prs) {
      const candidateIssue =
        this.prLinker.parsePrBody(pr.body) ??
        this.prLinker.parseBranchName(pr.head.ref);

      if (candidateIssue === null) {
        unlinked.push(pr);
        continue;
      }

      const group = issueGroups.get(candidateIssue);
      if (group) {
        group.push(pr);
      } else {
        issueGroups.set(candidateIssue, [pr]);
      }
    }

    const result: typeof prs = [...unlinked];

    for (const [issueNumber, group] of issueGroups) {
      if (group.length === 1) {
        result.push(group[0]!);
        continue;
      }

      // Sort by updated_at descending — most recent first
      group.sort((a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );

      const mostRecent = group[0]!;
      result.push(mostRecent);

      // Log warning for skipped older PRs
      const skipped = group.slice(1);
      for (const skippedPr of skipped) {
        this.logger.warn(
          { owner, repo, issueNumber, skippedPrNumber: skippedPr.number, processedPrNumber: mostRecent.number },
          `Skipping older PR #${skippedPr.number} for issue #${issueNumber} — processing most recent PR #${mostRecent.number}`,
        );
      }
    }

    return result;
  }

  /**
   * Check if an error is a GitHub API rate limit error.
   */
  private isRateLimitError(error: unknown): boolean {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return msg.includes('rate limit') || msg.includes('api rate') || msg.includes('403');
    }
    return false;
  }

  // ==========================================================================
  // Adaptive Polling
  // ==========================================================================

  /**
   * Record that a webhook event was received, updating health tracking.
   */
  recordWebhookEvent(): void {
    this.state.lastWebhookEvent = Date.now();
    this.state.webhookHealthy = true;
    const decision = decideAdaptivePoll({
      webhooksConfigured: this.state.webhooksConfigured,
      adaptivePolling: this.options.adaptivePolling,
      basePollIntervalMs: this.state.basePollIntervalMs,
      currentPollIntervalMs: this.state.currentPollIntervalMs,
      lastWebhookEvent: this.state.lastWebhookEvent,
      webhookHealthy: this.state.webhookHealthy,
      adaptiveDivisor: ADAPTIVE_DIVISOR,
      minPollIntervalMs: MIN_POLL_INTERVAL_MS,
      nowMs: Date.now(),
    });
    this.state.currentPollIntervalMs = decision.currentPollIntervalMs;
    this.state.webhookHealthy = decision.webhookHealthy;
    if (decision.transition !== 'none') {
      this.logger.info(
        { intervalMs: this.state.currentPollIntervalMs, reason: decision.reason },
        'Webhook reconnected, restoring normal PR feedback poll interval',
      );
    }
  }

  /**
   * Update adaptive polling interval based on webhook health.
   */
  private updateAdaptivePolling(): void {
    const decision = decideAdaptivePoll({
      webhooksConfigured: this.state.webhooksConfigured,
      adaptivePolling: this.options.adaptivePolling,
      basePollIntervalMs: this.state.basePollIntervalMs,
      currentPollIntervalMs: this.state.currentPollIntervalMs,
      lastWebhookEvent: this.state.lastWebhookEvent,
      webhookHealthy: this.state.webhookHealthy,
      adaptiveDivisor: ADAPTIVE_DIVISOR,
      minPollIntervalMs: MIN_POLL_INTERVAL_MS,
      nowMs: Date.now(),
    });
    this.state.currentPollIntervalMs = decision.currentPollIntervalMs;
    this.state.webhookHealthy = decision.webhookHealthy;
    if (decision.transition !== 'none') {
      this.logger.info(
        { intervalMs: this.state.currentPollIntervalMs, reason: decision.reason },
        'Webhooks appear unhealthy, increasing PR feedback poll frequency',
      );
    }
  }

  // ==========================================================================
  // State Access
  // ==========================================================================

  getState(): Readonly<MonitorState> {
    return { ...this.state };
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /**
   * Resolve workflow name from the issue's labels.
   * Checks workflow:* labels first (authoritative, set by label monitor on process events),
   * then falls back to process:* / completed:* / agent:* for pre-migration issues.
   * Falls back to 'unknown' if no workflow label is found.
   */
  private async resolveWorkflowName(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<string> {
    try {
      const client = this.createClient(undefined, this.tokenProvider);
      const issue = await client.getIssue(owner, repo, issueNumber);

      // Primary: persistent workflow:* label (authoritative)
      for (const label of issue.labels) {
        if (label.name.startsWith('workflow:')) {
          return label.name.slice('workflow:'.length);
        }
      }

      // Fallback: existing logic for pre-migration issues
      for (const label of issue.labels) {
        if (label.name.startsWith('process:')) {
          return label.name.slice('process:'.length);
        }
        if (label.name.startsWith('completed:')) {
          return label.name.slice('completed:'.length);
        }
      }

      // Check agent:* labels for workflow name fallback
      for (const label of issue.labels) {
        if (label.name.startsWith('agent:') && label.name !== 'agent:in-progress' && label.name !== 'agent:error' && label.name !== 'agent:dispatched' && label.name !== 'agent:paused') {
          return label.name.slice('agent:'.length);
        }
      }
    } catch (error) {
      this.logger.warn(
        { err: error, owner, repo, issueNumber },
        'Failed to resolve workflow name from issue labels',
      );
    }

    return 'unknown';
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }

      const timer = setTimeout(resolve, ms);

      // Clean up timer if abort is signaled
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/**
 * Simple semaphore for concurrency limiting.
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
    if (next) {
      next();
    }
  }
}
