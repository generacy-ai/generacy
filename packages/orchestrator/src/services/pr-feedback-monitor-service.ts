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
import { PrLinker, type PrLinkInput, type PrLinkResult } from '../worker/pr-linker.js';
import type { Logger } from '../worker/types.js';
import type { AuthHealthSink } from './label-monitor-service.js';
import { decideAdaptivePoll } from './adaptive-poll-controller.js';
import {
  classifyDropSeverity,
  emitDropLog,
  type DropTransitionState,
} from './drop-log-helper.js';
import type { DispatchConfig } from '../config/index.js';

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

/**
 * #987: options for the runtime `setWebhooksConfigured(true, opts?)` flip.
 * See specs/987-summary-cluster-where-smee/contracts/setter-contract.md.
 */
export interface SetWebhooksConfiguredOptions {
  basePollIntervalMs?: number;
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

  /**
   * #1070 Q1=A / FR-006 / Assumption 4: per-stateKey retry counter for the
   * blocked:fixer-timeout retry-eligible branch. Mirrors the sibling
   * lastUnresolvedThreadCount map above. Instance-scoped so state doesn't
   * leak across services.
   *
   * Key: `${owner}/${repo}#${prNumber}` (same as lastUnresolvedThreadCount).
   * Value: number of auto-retries dispatched so far, capped at 2 per Q5=C.
   *
   * Write sites:
   *   - Increment in the retry-eligible branch of processPrReviewEvent per D-4.
   *   - Delete in Case C (`totalUnresolvedThreads === 0`) per D-5 (progress-
   *     only reset, Q5=C).
   *
   * Read sites:
   *   - Retry-eligible branch decides `counter < 2` for dispatch permission.
   *   - Same branch bakes the current value into `PrFeedbackMetadata.retryAttempt`
   *     for handler consumption.
   *
   * Restart-loss failure mode is bounded and benign (spec §Assumption 7).
   */
  private fixerTimeoutRetryCount: Map<string, number> = new Map();

  // #1054 / FR-006 / FR-007: per-itemKey severity state for the in-flight-drop
  // transition-edge decision. Keyed by `${owner}/${repo}#${issueNumber}`.
  // Instance-scoped so state doesn't leak across services (SC-004 divergence).
  private monitorDropState: Map<string, DropTransitionState> = new Map();

  private readonly maxRunDurationMs: number;

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
    dispatchConfig?: Pick<DispatchConfig, 'maxRunDurationMs'>,
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
    this.maxRunDurationMs = dispatchConfig?.maxRunDurationMs ?? 1_800_000;
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

    // #1049 (FR-008): merged-PR gate — first check, before PrLinker. Runs
    // before any checkout/fetch/push code path can run. Poll path always
    // hardcodes `prMerged: false`, so this gate is webhook-driven.
    if (event.prMerged) {
      this.logger.info(
        { owner, repo, prNumber, gate: 'merged-pr', source },
        'PR-feedback event dropped by merged-pr gate (PR is merged; reviews on merged PRs are not processed)',
      );
      return false;
    }

    // 1. Link PR to orchestrated issue
    const prInput: PrLinkInput = {
      number: prNumber,
      body: prBody,
      head: { ref: branchName },
    };

    const linkResult = await this.prLinker.linkPrToIssue(client, owner, repo, prInput);
    if (linkResult.kind !== 'ok') {
      if (linkResult.kind === 'no-issue') {
        this.logger.warn(
          { owner, repo, prNumber, issueNumber: linkResult.issueNumber, gate: 'no-issue', source },
          'PR-feedback event dropped by no-issue gate (linked issue could not be fetched)',
        );
        return false;
      }
      await this.dropWithGateLog(client, event, linkResult);
      return false;
    }

    const { link } = linkResult;
    const { issueNumber, linkMethod, assignees } = link;

    // 2. Assignee check — skip PR feedback for issues not assigned to this cluster
    //    Uses assignees returned by PrLinker to avoid a duplicate getIssue() call
    if (this.clusterGithubUsername) {
      if (assignees.length === 0) {
        await this.dropWithGateLog(client, event, {
          kind: 'assignees-empty',
          issueNumber,
        });
        return false;
      }
      if (!assignees.includes(this.clusterGithubUsername)) {
        this.logger.debug(
          { owner, repo, issueNumber, prNumber, assignees, gate: 'wrong-cluster', source },
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
      // #1070 D-5 / FR-013 (Q5=C): the sole counter-reset site. Case C fires
      // naturally on the next monitor poll after all review threads are fully
      // resolved (via Disposition A on the handler side OR manual operator
      // resolution). Map.delete on absent key is a no-op — safe unconditional
      // invocation.
      this.fixerTimeoutRetryCount.delete(stateKey);
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
    // #1070 FR-006 / D-4: retry-eligible check fires BEFORE the blocked:*
    // short-circuit. Preserves Assumption 5 — any UNRECOGNIZED blocked:*
    // label still pauses the monitor; only the specific `blocked:fixer-timeout`
    // (retry-eligible) is carved out here.
    //
    // PR #1072 review — order-of-operations fix: check for any OTHER blocked:*
    // label FIRST, before touching the counter or removing the label. Multiple
    // handlers (`pr-feedback-handler`, `merge-conflict-handler`,
    // `validate-fix-handler`) all write `blocked:*` labels to the same issue
    // and do not coordinate, so two coexisting blocked labels is a normal
    // state. If we consume the retry budget + remove the timeout signal and
    // THEN discover another blocked label is present, we silently destroy the
    // timeout signal (label gone from the issue) and burn a retry on a
    // dispatch that never happens. The invariant is: do not mutate remote
    // state or consume budget until the dispatch is committed.
    const otherBlocked = issueLabels.find(
      l => l.startsWith('blocked:') && l !== 'blocked:fixer-timeout',
    );
    if (!otherBlocked && issueLabels.includes('blocked:fixer-timeout')) {
      const priorRetries = this.fixerTimeoutRetryCount.get(stateKey) ?? 0;
      if (priorRetries < 2) {
        // Budget remaining — remove the retry-eligible label and continue to
        // the normal enqueue path with an incremented counter.
        let removed = true;
        try {
          await client.removeLabels(owner, repo, issueNumber, ['blocked:fixer-timeout']);
        } catch (error) {
          removed = false;
          this.logger.warn(
            { err: error, owner, repo, issueNumber },
            'Failed to remove blocked:fixer-timeout before retry dispatch — non-fatal, will re-check on next poll',
          );
          // Fall through to the blocked:* skip check below — safer than
          // dispatching with the label still present (would race the handler's
          // own removeLabels call).
        }
        if (removed) {
          this.fixerTimeoutRetryCount.set(stateKey, priorRetries + 1);
          // Filter the just-removed label out of the local list so the
          // generic blocked:* short-circuit below does NOT re-match it. The
          // API removal happened successfully; the local array is a snapshot
          // taken before the removal.
          issueLabels = issueLabels.filter(l => l !== 'blocked:fixer-timeout');
          this.logger.info(
            {
              owner, repo, prNumber, issueNumber,
              priorRetries,
              newRetries: priorRetries + 1,
              gate: 'blocked-fixer-timeout-retry-dispatch',
            },
            'Dispatching auto-retry after blocked:fixer-timeout (Q5=C, max 2)',
          );
          // Do NOT return — fall through to the normal enqueue path.
        }
      } else {
        // priorRetries >= 2. Defense in depth: handler should have applied
        // blocked:fixer-timeout-repeat and this branch shouldn't fire. If it
        // does, log and fall through to the blocked:* skip check below.
        this.logger.warn(
          {
            owner, repo, prNumber, issueNumber,
            priorRetries,
            gate: 'blocked-fixer-timeout-budget-exhausted',
          },
          'blocked:fixer-timeout present but retry budget exhausted — expected blocked:fixer-timeout-repeat (handler bug?)',
        );
        // Fall through to the blocked:* skip check below (which will match).
      }
    }

    const blockedLabel = issueLabels.find(l => l.startsWith('blocked:'));
    if (blockedLabel) {
      this.logger.info(
        {
          owner, repo, prNumber, issueNumber,
          blockedLabel,
          unresolvedThreads: unresolvedThreadIds.length,
          reason: 'blocked-label-present',
          gate: 'blocked-label-present',
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

    // 6. Build queue item.
    // #1070 D-1 / handler-counter-seam: attach the current retry counter to
    // every enqueue (both the normal path AND the retry-eligible branch above,
    // which has already incremented). Non-retry dispatches get 0. Handler
    // reads `?? 0` for pre-#1070 backwards compatibility.
    const currentRetries = this.fixerTimeoutRetryCount.get(stateKey) ?? 0;
    const metadata: PrFeedbackMetadata = {
      prNumber,
      reviewThreadIds: unresolvedThreadIds,
      retryAttempt: currentRetries,
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
      // #1054 / FR-006 / FR-007: transition-edge severity escalation via the
      // shared helper. Context fields preserved verbatim (only severity flips).
      const ageMs = await this.queueManager.hasInFlightAge(itemKey);
      const decision = classifyDropSeverity(
        itemKey,
        ageMs,
        this.maxRunDurationMs,
        this.monitorDropState,
      );
      emitDropLog(
        this.logger,
        decision,
        { itemKey, reason: 'in-flight', prNumber, issueNumber, owner, repo, ageMs },
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
  // #1049 / FR-004, FR-005: drop-gate logging
  // ==========================================================================

  /**
   * Probe for unresolved review-thread count. Runs the existing GraphQL
   * `getPRReviewThreads` call and counts unresolved threads. Used only at
   * drop-time to decide whether to lift a drop-gate log line from `debug`
   * to `info` (FR-004). Not called for merged-pr / wrong-cluster gates.
   */
  private async probeUnresolvedThreads(
    client: GitHubClient,
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<number> {
    const threads = await client.getPRReviewThreads(owner, repo, prNumber);
    return threads.filter(t => !t.isResolved).length;
  }

  /**
   * Log a drop-gate event with the right level and gate name (FR-004, FR-005).
   *
   * For `source === 'webhook'` (rare, user-driven), probes unresolved-thread
   * count and lifts to `info` when ≥1, else `debug`. Probe errors fall back
   * to `debug` with `probeError` field — a failed probe MUST NOT itself
   * become an error signal.
   *
   * For `source === 'poll'` (steady-state, every ~60s per open PR per repo),
   * the probe is SKIPPED and the log line drops to `debug`. Rationale: the
   * poll path iterates every open PR in every monitored repo and reaches
   * this helper for each unlinked / non-orchestrated / assignees-empty PR
   * on every cycle. An unconditional GraphQL probe there would amplify to
   * ~60 queries/hour per PR against a shared 5 000/hr GitHub budget, and an
   * `info` line per unlinked human/bot PR would spam every 60 s indefinitely.
   * The lifted-to-`info` diagnostic is preserved for the one-shot webhook
   * path, which is what operators care about.
   */
  private async dropWithGateLog(
    client: GitHubClient,
    event: PrReviewEvent,
    result:
      | Extract<PrLinkResult, { kind: 'no-link' }>
      | Extract<PrLinkResult, { kind: 'not-orchestrated' }>
      | { kind: 'assignees-empty'; issueNumber: number },
  ): Promise<void> {
    const { owner, repo, prNumber, source } = event;
    const gate =
      result.kind === 'no-link' ? 'no-link' :
      result.kind === 'not-orchestrated' ? 'not-orchestrated' :
      'assignees-empty';
    const issueNumber = result.kind === 'no-link' ? undefined : result.issueNumber;

    if (source === 'poll') {
      this.logger.debug(
        { owner, repo, prNumber, issueNumber, gate, source },
        `PR-feedback event dropped by ${gate} gate (poll path — probe skipped)`,
      );
      return;
    }

    let unresolvedThreads: number;
    try {
      unresolvedThreads = await this.probeUnresolvedThreads(client, owner, repo, prNumber);
    } catch (err) {
      this.logger.debug(
        {
          owner, repo, prNumber, issueNumber, gate, source,
          probeError: err instanceof Error ? err.message : String(err),
        },
        `PR-feedback event dropped by ${gate} gate (probe failed)`,
      );
      return;
    }

    if (unresolvedThreads >= 1) {
      this.logger.info(
        { owner, repo, prNumber, issueNumber, gate, source, unresolvedThreads },
        `PR-feedback event dropped by ${gate} gate (PR has ${unresolvedThreads} unresolved thread(s))`,
      );
    } else {
      this.logger.debug(
        { owner, repo, prNumber, issueNumber, gate, source, unresolvedThreads: 0 },
        `PR-feedback event dropped by ${gate} gate (no unresolved threads)`,
      );
    }
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
        // #1049 (D5): poll uses listOpenPullRequests → open-only invariant.
        prMerged: false,
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

  /**
   * #987: flip `webhooksConfigured` to `true` at runtime. Setter is one-way
   * (Q1); `adaptivePolling` stays untouched so the staleness safety net is
   * reachable (Q2). See specs/987-summary-cluster-where-smee/clarifications.md.
   */
  setWebhooksConfigured(configured: true, opts?: SetWebhooksConfiguredOptions): void {
    void configured;
    this.state.webhooksConfigured = true;
    if (opts?.basePollIntervalMs !== undefined) {
      this.state.basePollIntervalMs = opts.basePollIntervalMs;
      this.state.currentPollIntervalMs = opts.basePollIntervalMs;
    }
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
