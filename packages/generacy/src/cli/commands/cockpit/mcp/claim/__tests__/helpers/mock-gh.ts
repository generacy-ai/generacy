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
    return {
      fetchIssueLabels: async (repo, issue) => {
        this.calls.push({ method: 'fetchIssueLabels', args: [repo, issue] });
        return { labels: [...this.state(repo, issue).labels] };
      },
      fetchIssueComments: async (repo, issue) => {
        this.calls.push({ method: 'fetchIssueComments', args: [repo, issue] });
        return [...this.state(repo, issue).comments];
      },
      postIssueComment: async (repo, issue, body) => {
        this.calls.push({ method: 'postIssueComment', args: [repo, issue, body] });
        this.maybeFail('postIssueComment');
        const s = this.state(repo, issue);
        const id = s.nextCommentId++;
        const url = this.commentUrl(repo, issue, id);
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
        this.calls.push({ method: 'editIssueComment', args: [repo, commentId, body] });
        this.maybeFail('editIssueComment');
        for (const [key, s] of this.issues) {
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
        this.calls.push({ method: 'deleteIssueComment', args: [repo, commentId] });
        this.maybeFail('deleteIssueComment');
        for (const [key, s] of this.issues) {
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
        this.calls.push({ method: 'addLabels', args: [repo, issue, labels] });
        this.maybeFail('addLabels');
        const s = this.state(repo, issue);
        for (const l of labels) s.labels.add(l);
      },
      removeLabels: async (repo, issue, labels) => {
        this.calls.push({ method: 'removeLabels', args: [repo, issue, labels] });
        this.maybeFail('removeLabels');
        const s = this.state(repo, issue);
        for (const l of labels) s.labels.delete(l);
      },
    } as unknown as GhWrapper;
  }
}
