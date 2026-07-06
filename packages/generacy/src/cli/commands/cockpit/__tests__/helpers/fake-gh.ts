import type {
  CheckRunSummary,
  GhWrapper,
  Issue,
  IssueComment,
  IssueLabelsResult,
  IssueStateResult,
  ListIssuesOptions,
  MergeResult,
  OpenPrForBranch,
  PullRequestDetail,
  PullRequestRef,
  PullRequestSummary,
  RequiredChecksResult,
} from '@generacy-ai/cockpit';

export interface FakeGhConfig {
  issuesByQuery?: (query: string, options?: ListIssuesOptions) => Issue[];
  issuesScript?: Issue[][];
  checksByPr?: Record<string, CheckRunSummary[]>;
  prByPr?: Record<string, PullRequestSummary>;
  resolveIssueToPRByIssue?: Record<string, number | null>;
  /**
   * Body strings keyed by `owner/repo#N`. `getIssue()` returns an Issue with
   * this body. If the key is missing, an issue with an empty body is returned.
   */
  bodyByIssue?: Record<string, string>;
  /** Callback form for `getIssue()`; overrides `bodyByIssue` when set. */
  getIssueBy?: (repo: string, number: number) => Issue;
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

  async getIssue(repo: string, number: number): Promise<Issue> {
    this.calls.push({ method: 'getIssue', args: [repo, number] });
    if (this.config.getIssueBy != null) return this.config.getIssueBy(repo, number);
    const key = `${repo}#${number}`;
    const body = this.config.bodyByIssue?.[key] ?? '';
    return {
      number,
      title: `Issue ${number}`,
      state: 'OPEN',
      labels: [],
      url: `https://github.com/${repo}/issues/${number}`,
      body,
      createdAt: '',
    };
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

  async resolveIssueToPRRef(repo: string, issue: number): Promise<PullRequestRef | null> {
    this.calls.push({ method: 'resolveIssueToPRRef', args: [repo, issue] });
    throw new Error('resolveIssueToPRRef not stubbed in FakeGh (watch/status sensor)');
  }

  async getPullRequestDetail(repo: string, prNumber: number): Promise<PullRequestDetail> {
    this.calls.push({ method: 'getPullRequestDetail', args: [repo, prNumber] });
    throw new Error('getPullRequestDetail not stubbed in FakeGh (watch/status sensor)');
  }

  async mergePullRequest(
    repo: string,
    prNumber: number,
    _opts: { squash: true },
  ): Promise<MergeResult> {
    this.calls.push({ method: 'mergePullRequest', args: [repo, prNumber] });
    throw new Error('mergePullRequest is forbidden in FakeGh (watch/status sensor)');
  }

  async getRequiredCheckNames(repo: string, branch: string): Promise<RequiredChecksResult> {
    this.calls.push({ method: 'getRequiredCheckNames', args: [repo, branch] });
    throw new Error('getRequiredCheckNames not stubbed in FakeGh (watch/status sensor)');
  }

  async addLabel(repo: string, issue: number, label: string): Promise<void> {
    this.calls.push({ method: 'addLabel', args: [repo, issue, label] });
    if (this.config.strict === true) {
      throw new Error(`watch is a sensor — addLabel(${repo}, #${issue}, ${label}) is forbidden`);
    }
  }

  async removeLabel(repo: string, issue: number, label: string): Promise<void> {
    this.calls.push({ method: 'removeLabel', args: [repo, issue, label] });
    if (this.config.strict === true) {
      throw new Error(`watch is a sensor — removeLabel(${repo}, #${issue}, ${label}) is forbidden`);
    }
  }

  async fetchIssueLabels(repo: string, issue: number): Promise<IssueLabelsResult> {
    this.calls.push({ method: 'fetchIssueLabels', args: [repo, issue] });
    throw new Error('fetchIssueLabels not stubbed in FakeGh');
  }

  async fetchIssueState(repo: string, issue: number): Promise<IssueStateResult> {
    this.calls.push({ method: 'fetchIssueState', args: [repo, issue] });
    throw new Error('fetchIssueState not stubbed in FakeGh');
  }

  async postIssueComment(
    repo: string,
    issue: number,
    body: string,
  ): Promise<{ url: string }> {
    this.calls.push({ method: 'postIssueComment', args: [repo, issue, body] });
    throw new Error('postIssueComment not stubbed in FakeGh');
  }

  async addAssignees(
    repo: string,
    issue: number,
    logins: string[],
  ): Promise<void> {
    this.calls.push({ method: 'addAssignees', args: [repo, issue, logins] });
    throw new Error('addAssignees not stubbed in FakeGh');
  }

  async fetchIssueTimeline(repo: string, issue: number): Promise<unknown[]> {
    this.calls.push({ method: 'fetchIssueTimeline', args: [repo, issue] });
    throw new Error('fetchIssueTimeline not stubbed in FakeGh');
  }

  async fetchIssueComments(repo: string, issue: number): Promise<IssueComment[]> {
    this.calls.push({ method: 'fetchIssueComments', args: [repo, issue] });
    throw new Error('fetchIssueComments not stubbed in FakeGh');
  }

  async getCurrentUser(): Promise<string> {
    this.calls.push({ method: 'getCurrentUser', args: [] });
    throw new Error('getCurrentUser not stubbed in FakeGh');
  }

  async findOpenPrForBranch(
    repo: string,
    branch: string,
  ): Promise<OpenPrForBranch | null> {
    this.calls.push({ method: 'findOpenPrForBranch', args: [repo, branch] });
    throw new Error('findOpenPrForBranch not stubbed in FakeGh');
  }

  async prDiffNames(repo: string, prNumber: number): Promise<string[]> {
    this.calls.push({ method: 'prDiffNames', args: [repo, prNumber] });
    throw new Error('prDiffNames not stubbed in FakeGh');
  }

  async prDiffPatch(repo: string, prNumber: number): Promise<string> {
    this.calls.push({ method: 'prDiffPatch', args: [repo, prNumber] });
    throw new Error('prDiffPatch not stubbed in FakeGh');
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
