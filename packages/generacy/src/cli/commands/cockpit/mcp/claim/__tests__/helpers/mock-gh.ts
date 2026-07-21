/**
 * Minimal in-memory GhWrapper stub for claim/ tests. Simulates the subset of
 * GitHub state exercised by discover/acquire/release: per-issue label set
 * and comment list. Not a general-purpose FakeGh — see
 * packages/generacy/src/cli/commands/cockpit/__tests__/helpers/fake-gh.ts
 * for the wider harness.
 */
import type { GhWrapper, IssueComment } from '@generacy-ai/cockpit';

export type FailureMap = Partial<{
  editIssueComment: () => Error | null;
  deleteIssueComment: () => Error | null;
  addLabels: () => Error | null;
  removeLabels: () => Error | null;
  postIssueComment: () => Error | null;
}>;

export interface IssueState {
  labels: Set<string>;
  comments: IssueComment[];
  nextCommentId: number;
}

export class ClaimMockGh {
  public calls: Array<{ method: string; args: unknown[] }> = [];
  private readonly issues = new Map<string, IssueState>();
  public failure: FailureMap = {};

  private key(repo: string, issue: number): string {
    return `${repo}#${issue}`;
  }

  private state(repo: string, issue: number): IssueState {
    const k = this.key(repo, issue);
    let s = this.issues.get(k);
    if (s === undefined) {
      s = { labels: new Set(), comments: [], nextCommentId: 100_000 };
      this.issues.set(k, s);
    }
    return s;
  }

  seedComment(
    repo: string,
    issue: number,
    body: string,
    overrides?: Partial<IssueComment>,
  ): IssueComment {
    const s = this.state(repo, issue);
    const id = overrides?.id ?? s.nextCommentId++;
    const comment: IssueComment = {
      id,
      body,
      author: overrides?.author ?? 'tester',
      createdAt: overrides?.createdAt ?? '2026-07-21T14:00:00.000Z',
      url: overrides?.url ?? this.commentUrl(repo, issue, id),
    };
    s.comments.push(comment);
    return comment;
  }

  seedLabel(repo: string, issue: number, label: string): void {
    this.state(repo, issue).labels.add(label);
  }

  getComments(repo: string, issue: number): IssueComment[] {
    return [...this.state(repo, issue).comments];
  }

  getLabels(repo: string, issue: number): string[] {
    return [...this.state(repo, issue).labels];
  }

  countWrites(): number {
    return this.calls.filter((c) =>
      [
        'postIssueComment',
        'editIssueComment',
        'deleteIssueComment',
        'addLabels',
        'removeLabels',
      ].includes(c.method),
    ).length;
  }

  private commentUrl(repo: string, issue: number, id: number): string {
    return `https://github.com/${repo}/issues/${issue}#issuecomment-${id}`;
  }

  private maybeFail(method: keyof FailureMap): void {
    const gate = this.failure[method];
    if (gate === undefined) return;
    const err = gate();
    if (err !== null) throw err;
  }

  build(): GhWrapper {
    const self = this;
    return {
      fetchIssueLabels: async (repo, issue) => {
        self.calls.push({ method: 'fetchIssueLabels', args: [repo, issue] });
        return { labels: [...self.state(repo, issue).labels] };
      },
      fetchIssueComments: async (repo, issue) => {
        self.calls.push({ method: 'fetchIssueComments', args: [repo, issue] });
        return [...self.state(repo, issue).comments];
      },
      postIssueComment: async (repo, issue, body) => {
        self.calls.push({ method: 'postIssueComment', args: [repo, issue, body] });
        self.maybeFail('postIssueComment');
        const s = self.state(repo, issue);
        const id = s.nextCommentId++;
        const url = self.commentUrl(repo, issue, id);
        s.comments.push({
          id,
          body,
          author: 'test-actor',
          createdAt: '2026-07-21T14:00:00.000Z',
          url,
        });
        return { url };
      },
      editIssueComment: async (repo, commentId, body) => {
        self.calls.push({ method: 'editIssueComment', args: [repo, commentId, body] });
        self.maybeFail('editIssueComment');
        for (const [key, s] of self.issues) {
          if (!key.startsWith(`${repo}#`)) continue;
          const comment = s.comments.find((c) => c.id === commentId);
          if (comment !== undefined) {
            comment.body = body;
            return;
          }
        }
        throw new Error(`editIssueComment: comment ${commentId} not found in ${repo}`);
      },
      deleteIssueComment: async (repo, commentId) => {
        self.calls.push({ method: 'deleteIssueComment', args: [repo, commentId] });
        self.maybeFail('deleteIssueComment');
        for (const [key, s] of self.issues) {
          if (!key.startsWith(`${repo}#`)) continue;
          const idx = s.comments.findIndex((c) => c.id === commentId);
          if (idx >= 0) {
            s.comments.splice(idx, 1);
            return;
          }
        }
        // treat missing as idempotent success (matches real wrapper's 404 handling)
      },
      addLabels: async (repo, issue, labels) => {
        self.calls.push({ method: 'addLabels', args: [repo, issue, labels] });
        self.maybeFail('addLabels');
        const s = self.state(repo, issue);
        for (const l of labels) s.labels.add(l);
      },
      removeLabels: async (repo, issue, labels) => {
        self.calls.push({ method: 'removeLabels', args: [repo, issue, labels] });
        self.maybeFail('removeLabels');
        const s = self.state(repo, issue);
        for (const l of labels) s.labels.delete(l);
      },
    } as unknown as GhWrapper;
  }
}
