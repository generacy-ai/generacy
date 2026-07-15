/**
 * #942: Failure fingerprint history tracker.
 *
 * Default implementation (Q2→A) scans the issue's failure-alert comment thread
 * and counts prior comments whose v2 marker carries the same fingerprint.
 * Never throws — any transport error returns 0 and logs a warning
 * (fail-open: escalation may be missed once, but the alert still posts and
 * the next failure will catch up).
 */

import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { FailureFingerprint, Logger } from '../worker/types.js';
import { FAILURE_ALERT_MARKER_PREFIX } from '../worker/types.js';
import { parseFailureAlertMarker } from '../worker/failure-fingerprint.js';

export interface FailureFingerprintTracker {
  /**
   * Count of prior failure-alert comments on the issue whose parsed v2 marker
   * carries a matching fingerprint. Excludes the current in-flight failure
   * (call BEFORE postFailureAlert).
   *
   * Failure-tolerant: any thrown error → warn + return 0. Never propagates.
   */
  countPriorOccurrences(
    owner: string,
    repo: string,
    issue: number,
    fingerprint: FailureFingerprint,
  ): Promise<number>;
}

export class GitHubCommentFailureFingerprintTracker implements FailureFingerprintTracker {
  constructor(
    private readonly github: GitHubClient,
    private readonly logger: Logger,
  ) {}

  async countPriorOccurrences(
    owner: string,
    repo: string,
    issue: number,
    fingerprint: FailureFingerprint,
  ): Promise<number> {
    try {
      const comments = await this.github.getIssueComments(owner, repo, issue);
      let count = 0;
      for (const c of comments) {
        if (!c.body.startsWith(FAILURE_ALERT_MARKER_PREFIX)) continue;
        const parsed = parseFailureAlertMarker(c.body);
        if (parsed?.fingerprint === fingerprint) count++;
      }
      return count;
    } catch (err) {
      this.logger.warn(
        { err: String(err), owner, repo, issue, fingerprint },
        'Failed to scan issue comments for fingerprint history; treating as first occurrence',
      );
      return 0;
    }
  }
}
