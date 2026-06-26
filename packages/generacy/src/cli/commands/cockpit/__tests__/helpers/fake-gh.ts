import type {
  CheckRunSummary,
  GhWrapper,
  Issue,
  ListIssuesOptions,
  PullRequestSummary,
} from '@generacy-ai/cockpit';

export interface FakeGhConfig {
  issuesByQuery?: (query: string, options?: ListIssuesOptions) => Issue[];
  issuesScript?: Issue[][];
  checksByPr?: Record<string, CheckRunSummary[]>;
  prByPr?: Record<string, PullRequestSummary>;
  resolveIssueToPRByIssue?: Record<string, number | null>;
  strict?: boolean;
}

export interface FakeGhCall {
  method: string;
  args: unknown[];
}

export class FakeGh implements GhWrapper {
  public calls: FakeGhCall[] = [];
  private scriptCursor = 0;

  constructor(private readonly config: FakeGhConfig = {}) {}

  async listIssues(query: string, options?: ListIssuesOptions): Promise<Issue[]> {
    this.calls.push({ method: 'listIssues', args: [query, options] });
    if (this.config.issuesByQuery != null) return this.config.issuesByQuery(query, options);
    if (this.config.issuesScript != null) {
      const page = this.config.issuesScript[this.scriptCursor] ?? [];
      this.scriptCursor += 1;
      return page;
    }
    return [];
  }

  async addLabels(repo: string, issue: number, labels: string[]): Promise<void> {
    this.calls.push({ method: 'addLabels', args: [repo, issue, labels] });
    if (this.config.strict === true) {
      throw new Error(`watch is a sensor — addLabels(${repo}, #${issue}, ${labels.join(',')}) is forbidden`);
    }
  }

  async removeLabels(repo: string, issue: number, labels: string[]): Promise<void> {
    this.calls.push({ method: 'removeLabels', args: [repo, issue, labels] });
    if (this.config.strict === true) {
      throw new Error(`watch is a sensor — removeLabels(${repo}, #${issue}, ${labels.join(',')}) is forbidden`);
    }
  }

  async getPullRequestCheckRuns(repo: string, prNumber: number): Promise<CheckRunSummary[]> {
    this.calls.push({ method: 'getPullRequestCheckRuns', args: [repo, prNumber] });
    const key = `${repo}#${prNumber}`;
    return this.config.checksByPr?.[key] ?? [];
  }

  async resolveIssueToPR(repo: string, issueNumber: number): Promise<number | null> {
    this.calls.push({ method: 'resolveIssueToPR', args: [repo, issueNumber] });
    const key = `${repo}#${issueNumber}`;
    return this.config.resolveIssueToPRByIssue?.[key] ?? null;
  }

  async getPullRequest(repo: string, prNumber: number): Promise<PullRequestSummary> {
    this.calls.push({ method: 'getPullRequest', args: [repo, prNumber] });
    const key = `${repo}#${prNumber}`;
    const summary = this.config.prByPr?.[key];
    if (summary != null) return summary;
    return {
      number: prNumber,
      state: 'OPEN',
      url: `https://github.com/${repo}/pull/${prNumber}`,
      isDraft: false,
      labels: [],
    };
  }
}

export function makeIssue(overrides: Partial<Issue> & { number: number }): Issue {
  return {
    title: `Issue ${overrides.number}`,
    state: 'OPEN',
    labels: [],
    url: `https://github.com/o/r/issues/${overrides.number}`,
    body: '',
    createdAt: `2026-06-${String(overrides.number).padStart(2, '0')}T00:00:00Z`,
    ...overrides,
  };
}

export function makePr(overrides: Partial<Issue> & { number: number }): Issue {
  return {
    title: `PR ${overrides.number}`,
    state: 'OPEN',
    labels: [],
    url: `https://github.com/o/r/pull/${overrides.number}`,
    body: '',
    createdAt: `2026-06-${String(overrides.number).padStart(2, '0')}T00:00:00Z`,
    ...overrides,
  };
}
