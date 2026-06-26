import type {
  CheckRunSummary,
  PullRequestDetail,
} from '@generacy-ai/cockpit';

export const DIFF_BYTE_CAP = 256 * 1024;

export interface ReviewContextPayload {
  pr: {
    number: number;
    title: string;
    url: string;
    base: string;
    head: string;
    body: string;
    author: string | null;
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    draft: boolean;
  };
  diff: string;
  diffTruncated: boolean;
  checks: Array<{
    name: string;
    state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED';
    conclusion?: string;
    url?: string;
  }>;
}

export interface BuildReviewContextInput {
  pr: PullRequestDetail;
  checks: CheckRunSummary[];
}

export function buildReviewContextPayload(
  input: BuildReviewContextInput,
): ReviewContextPayload {
  const { pr, checks } = input;
  return {
    pr: {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      base: pr.base,
      head: pr.head,
      body: pr.body,
      author: pr.author?.login ?? null,
      state: pr.state,
      draft: pr.draft,
    },
    diff: pr.diff,
    diffTruncated: pr.diffTruncated,
    checks: checks.map((c) => ({
      name: c.name,
      state: c.state,
      ...(c.conclusion != null ? { conclusion: c.conclusion } : {}),
      ...(c.url != null ? { url: c.url } : {}),
    })),
  };
}

export function serializeReviewContextJson(
  payload: ReviewContextPayload,
): string {
  return JSON.stringify(payload) + '\n';
}
