import { GhAuthError, type GitHubClientFactory } from '@generacy-ai/workflow-engine';
import { JitTokenError } from '@generacy-ai/control-plane';

// Minimal shape needed for grouping/filtering. Import inline to avoid depending
// on a `PullRequest` re-export the workflow-engine barrel doesn't expose.
interface FailingPr {
  number: number;
  base?: { ref: string };
  labels?: Array<{ name: string }>;
}
import type { PhaseTracker } from '../types/monitor.js';
import type { Logger } from '../worker/types.js';
import type { AuthHealthSink } from './label-monitor-service.js';

/** Label a failing PR carries at rest for base-advance re-arm scope. */
const FAILED_VALIDATE_LABEL = 'failed:validate';

/**
 * Repository descriptor (matches LabelMonitorService shape).
 */
export interface BaseAdvanceRepository {
  owner: string;
  repo: string;
}

/**
 * Options for `BaseAdvanceMonitorService`.
 */
export interface BaseAdvanceMonitorConfig {
  /** Poll interval in ms. Defaults to the same cadence as LabelMonitorService. */
  pollIntervalMs: number;
  /** Repositories to poll. */
  repositories: BaseAdvanceRepository[];
  /** Max concurrent `pollRepo()` calls per cycle. Default: 4. */
  concurrency: number;
}

/**
 * Payload the monitor hands to the enqueue-resume callback.
 * `newSha` is the base-branch head SHA that triggered the resume — surfaces
 * as `WorkerContext.baseSha` on the resumed worker (D7 ordering gate).
 */
export interface ResumeItem {
  owner: string;
  repo: string;
  issueNumber: number;
  reason: 'base-advance';
  newSha: string;
}

export type ResumeEnqueueCallback = (item: ResumeItem) => Promise<void>;

/**
 * Simple semaphore for `concurrency` bounding — mirrors the pattern in
 * `label-monitor-service.ts`.
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

/**
 * Detect base-branch head-SHA advances and, per advance, enqueue exactly one
 * `cockpit resume` per open PR at `failed:validate` targeting that base (#892).
 *
 * Read-only wrt GitHub state — only side-effects are the `enqueueResume`
 * callback and a Redis dedupe write via `PhaseTrackerService.markProcessedRaw`.
 *
 * See specs/892-found-during-cockpit-v1/contracts/base-advance-monitor.md.
 */
export class BaseAdvanceMonitorService {
  private abortController: AbortController | null = null;
  private isPolling = false;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly createClient: GitHubClientFactory,
    private readonly config: BaseAdvanceMonitorConfig,
    private readonly phaseTracker: PhaseTracker,
    private readonly enqueueResume: ResumeEnqueueCallback,
    private readonly tokenProvider?: () => Promise<string | undefined>,
    private readonly authHealth?: AuthHealthSink,
    private readonly githubAppCredentialId?: string,
  ) {}

  /**
   * Start the polling loop. Idempotent: a warn log fires if already running.
   */
  async startPolling(): Promise<void> {
    if (this.isPolling) {
      this.logger.warn('BaseAdvanceMonitorService: polling already running');
      return;
    }
    this.isPolling = true;
    const ac = new AbortController();
    this.abortController = ac;

    this.logger.info(
      { intervalMs: this.config.pollIntervalMs, repos: this.config.repositories.length },
      'Starting base-advance monitor polling',
    );

    while (!ac.signal.aborted) {
      this.inflight = this.pollCycle();
      try {
        await this.inflight;
      } catch (error) {
        this.logger.error({ err: error }, 'Error during base-advance poll cycle');
      }
      this.inflight = null;
      await this.sleep(this.config.pollIntervalMs, ac.signal);
    }

    this.isPolling = false;
    this.logger.info('Base-advance monitor polling stopped');
  }

  /**
   * Stop polling. Awaits any in-flight `pollCycle` before resolving.
   */
  async stopPolling(): Promise<void> {
    if (!this.abortController) return;
    this.abortController.abort();
    this.abortController = null;
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        // Errors already logged by the cycle body.
      }
    }
  }

  /**
   * One poll cycle across all watched repositories, semaphore-bounded.
   */
  async pollCycle(): Promise<void> {
    const repos = this.config.repositories;
    if (repos.length === 0) return;

    const sem = new Semaphore(this.config.concurrency);
    const tasks = repos.map(({ owner, repo }) =>
      sem.acquire().then(async (release) => {
        try {
          await this.pollRepo(owner, repo);
        } catch (error) {
          this.logger.warn(
            { err: error, owner, repo },
            'BaseAdvanceMonitor: pollRepo failed',
          );
        } finally {
          release();
        }
      }),
    );
    await Promise.allSettled(tasks);
  }

  /**
   * Poll a single repository: enumerate failing PRs, group by base branch,
   * resolve base head SHA once per group, enqueue resumes for PRs whose
   * last-seen SHA differs.
   */
  private async pollRepo(owner: string, repo: string): Promise<void> {
    const github = this.createClient(undefined, this.tokenProvider);

    let openPRs;
    try {
      openPRs = await github.listOpenPullRequests(owner, repo);
    } catch (error) {
      if (error instanceof JitTokenError) {
        this.logger.warn(
          { code: error.code, message: error.message, owner, repo },
          'JIT token failure — skipping base-advance cycle for repo',
        );
        return;
      }
      if (error instanceof GhAuthError) {
        if (this.githubAppCredentialId && this.authHealth) {
          this.authHealth.recordResult(this.githubAppCredentialId, { ok: false, statusCode: 401 });
        }
        this.logger.warn(
          { statusCode: 401, owner, repo },
          'BaseAdvanceMonitor: 401 from listOpenPullRequests — repo skipped',
        );
        return;
      }
      this.logger.warn({ err: error, owner, repo }, 'BaseAdvanceMonitor: listOpenPullRequests failed');
      return;
    }

    // Filter to PRs sitting at failed:validate.
    const failingPRs = openPRs.filter((pr) =>
      pr.labels?.some((l) => l.name === FAILED_VALIDATE_LABEL),
    );
    if (failingPRs.length === 0) return;

    // Group by base branch name.
    const byBase = new Map<string, FailingPr[]>();
    for (const pr of failingPRs) {
      const base = pr.base?.ref;
      if (!base) continue;
      const bucket = byBase.get(base) ?? [];
      bucket.push(pr);
      byBase.set(base, bucket);
    }

    for (const [baseBranch, prs] of byBase) {
      let newSha: string;
      try {
        newSha = await github.getRefHeadSha(owner, repo, baseBranch);
      } catch (error) {
        if (error instanceof GhAuthError) {
          if (this.githubAppCredentialId && this.authHealth) {
            this.authHealth.recordResult(this.githubAppCredentialId, { ok: false, statusCode: 401 });
          }
          this.logger.warn(
            { statusCode: 401, owner, repo, baseBranch },
            'BaseAdvanceMonitor: 401 from getRefHeadSha — group skipped',
          );
          continue;
        }
        this.logger.warn(
          { err: error, owner, repo, baseBranch },
          'BaseAdvanceMonitor: getRefHeadSha failed — group skipped',
        );
        continue;
      }

      for (const pr of prs) {
        // The PR's linked issue number defaults to the PR number itself unless
        // the caller has richer link data. Downstream (`cockpit resume`) is
        // responsible for issue↔PR resolution; the monitor's contract is one
        // enqueue per (issueNumber, newSha) where issueNumber is drawn from
        // the PR's labels-in-context.
        const issueNumber = pr.number;
        const key = `base-advance-tracker:${owner}:${repo}:${issueNumber}:${newSha}`;

        if (await this.phaseTracker.isDuplicateRaw(key)) continue;

        try {
          await this.enqueueResume({
            owner, repo, issueNumber, reason: 'base-advance', newSha,
          });
        } catch (error) {
          this.logger.warn(
            { err: error, owner, repo, issueNumber, newSha },
            'BaseAdvanceMonitor: enqueueResume failed — will retry next cycle',
          );
          continue; // Do NOT markProcessedRaw — retry next cycle.
        }

        try {
          await this.phaseTracker.markProcessedRaw(key);
          this.logger.info(
            { owner, repo, issueNumber, baseBranch, newSha },
            'BaseAdvanceMonitor: enqueued resume for base-advance',
          );
        } catch (error) {
          // Redis write failure — resume already enqueued. Next cycle may
          // re-enqueue on this SHA, which the downstream `cockpit resume`
          // handler's own dedupe (or the queue's in-flight collapse) will
          // absorb. Bound: one duplicate enqueue.
          this.logger.warn(
            { err: error, owner, repo, issueNumber, newSha },
            'BaseAdvanceMonitor: markProcessedRaw failed after enqueue',
          );
        }
      }

      if (this.githubAppCredentialId && this.authHealth) {
        this.authHealth.recordResult(this.githubAppCredentialId, { ok: true });
      }
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
