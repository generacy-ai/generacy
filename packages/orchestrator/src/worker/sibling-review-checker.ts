import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { LinkedPR } from '@generacy-ai/workflow-engine';
import type { Logger } from './types.js';
import { parsePRUrl } from './linked-pr-url-parser.js';

const execFile = promisify(execFileCb);

export interface SiblingReviewResult {
  /** Whether all linked PRs are approved */
  allApproved: boolean;
  /** Per-PR status for logging */
  statuses: Array<{
    repo: string;
    number: number;
    reviewDecision: string;
    approved: boolean;
  }>;
}

/**
 * Check whether all linked sibling PRs have been approved.
 * Returns { allApproved: true } immediately when linkedPRs is empty or undefined
 * (vacuous truth — single-repo workflows pass trivially).
 */
export async function checkSiblingReviews(
  linkedPRs: LinkedPR[] | undefined,
  logger: Logger,
): Promise<SiblingReviewResult> {
  if (!linkedPRs || linkedPRs.length === 0) {
    return { allApproved: true, statuses: [] };
  }

  const statuses: SiblingReviewResult['statuses'] = [];

  for (const pr of linkedPRs) {
    const parsed = parsePRUrl(pr.url);
    if (!parsed) {
      logger.warn({ url: pr.url }, 'Could not parse linked PR URL — skipping');
      statuses.push({ repo: pr.repo, number: pr.number, reviewDecision: 'UNKNOWN', approved: false });
      continue;
    }

    try {
      const { stdout } = await execFile('gh', [
        'pr', 'view', String(parsed.number),
        '-R', `${parsed.owner}/${parsed.repo}`,
        '--json', 'reviewDecision',
      ]);

      let reviewDecision = '';
      try {
        const json = JSON.parse(stdout.trim()) as { reviewDecision?: string };
        reviewDecision = json.reviewDecision ?? '';
      } catch {
        reviewDecision = '';
      }

      const approved = reviewDecision === 'APPROVED';
      statuses.push({ repo: pr.repo, number: parsed.number, reviewDecision, approved });

      logger.info(
        { repo: pr.repo, number: parsed.number, reviewDecision, approved },
        'Checked sibling PR review status',
      );
    } catch (error) {
      logger.warn(
        { repo: pr.repo, number: pr.number, error: String(error) },
        'Failed to check sibling PR review status — treating as not approved',
      );
      statuses.push({ repo: pr.repo, number: pr.number, reviewDecision: 'ERROR', approved: false });
    }
  }

  const allApproved = statuses.length > 0 && statuses.every((s) => s.approved);
  return { allApproved, statuses };
}
