import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { PrToIssueLink } from '../types/monitor.js';
import type { Logger } from './types.js';

/**
 * Input subset of a PullRequest needed for linking.
 * Avoids coupling to the full PullRequest type.
 */
export interface PrLinkInput {
  number: number;
  body: string;
  head: { ref: string };
}

/**
 * Utility class that resolves the link between a pull request and its
 * orchestrated issue.
 *
 * Resolution strategy (first match wins):
 *   1. Parse closing keywords in the PR body (`Closes #42`, `Fixes #7`, etc.)
 *   2. Parse the leading issue number from the branch name (`42-feature-name`)
 *
 * After a candidate issue number is found, the class verifies that the issue
 * exists and carries an `agent:*` label (i.e. it is orchestrated). PRs that
 * are not linked to an orchestrated issue return `null`.
 */
export class PrLinker {
  /**
   * Closing-keyword pattern (case-insensitive, word-boundary aware).
   * Matches: close/closes/closed/fix/fixes/fixed/resolve/resolves/resolved #N
   *
   * NOTE: We use a function to return a fresh regex each time because
   * RegExp objects with the `g` flag are stateful (they track `lastIndex`).
   */
  private static closingRegex(): RegExp {
    return /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s#(\d+)/gi;
  }

  /**
   * Branch-name pattern: leading digits followed by a hyphen.
   * Matches: `42-feature-name` → 42
   */
  private static readonly BRANCH_REGEX = /^(\d+)-/;

  constructor(private readonly logger: Logger) {}

  /**
   * Extract the first referenced issue number from a PR body using
   * GitHub closing keywords.
   *
   * @returns The issue number, or `null` if no keyword match is found.
   */
  parsePrBody(body: string): number | null {
    if (!body) return null;

    const match = PrLinker.closingRegex().exec(body);
    if (!match?.[1]) return null;

    return parseInt(match[1], 10);
  }

  /**
   * Extract an issue number from a branch name of the form `{N}-{description}`.
   *
   * @returns The issue number, or `null` if the branch doesn't match.
   */
  parseBranchName(branch: string): number | null {
    if (!branch) return null;

    const match = PrLinker.BRANCH_REGEX.exec(branch);
    if (!match?.[1]) return null;

    return parseInt(match[1], 10);
  }

  /**
   * Attempt to link a PR to an orchestrated issue.
   *
   * Resolution order:
   *   1. PR body closing keywords  (e.g. `Fixes #42`)
   *   2. Branch name prefix         (e.g. `42-feature-name`)
   *
   * After resolving a candidate, the linked issue is fetched to verify it
   * exists and carries an `agent:*` label. Returns `null` when no valid
   * link can be established.
   */
  async linkPrToIssue(
    github: GitHubClient,
    owner: string,
    repo: string,
    pr: PrLinkInput,
  ): Promise<PrToIssueLink | null> {
    // 1. Try PR body keywords first
    let issueNumber = this.parsePrBody(pr.body);
    let linkMethod: PrToIssueLink['linkMethod'] = 'pr-body';

    // 2. Fallback to branch name
    if (issueNumber === null) {
      issueNumber = this.parseBranchName(pr.head.ref);
      linkMethod = 'branch-name';
    }

    if (issueNumber === null) {
      this.logger.debug(
        { prNumber: pr.number, owner, repo },
        'No issue link found in PR body or branch name',
      );
      return null;
    }

    // 3. Verify the issue exists and is orchestrated (has agent:* label)
    try {
      const issue = await github.getIssue(owner, repo, issueNumber);
      const isOrchestrated = issue.labels.some((l) => l.name.startsWith('agent:'));

      if (!isOrchestrated) {
        this.logger.debug(
          { prNumber: pr.number, issueNumber, owner, repo },
          'Linked issue does not have an agent:* label — skipping non-orchestrated issue',
        );
        return null;
      }
    } catch (error) {
      this.logger.warn(
        { prNumber: pr.number, issueNumber, owner, repo, err: error },
        'Failed to fetch linked issue — it may not exist',
      );
      return null;
    }

    this.logger.info(
      { prNumber: pr.number, issueNumber, linkMethod, owner, repo },
      `Linked PR #${pr.number} to issue #${issueNumber} via ${linkMethod}`,
    );

    return {
      prNumber: pr.number,
      issueNumber,
      linkMethod,
    };
  }
}
