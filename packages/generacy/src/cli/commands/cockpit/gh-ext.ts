/**
 * Extra `gh` calls used by the cockpit verbs that are NOT on the foundation
 * `GhCliWrapper` surface (which is shaped for the watcher's batch flows):
 *
 *   - fetchIssueLabels(repo, n)
 *   - fetchIssueState(repo, n)         — labels + state + closedAt + assignees + title
 *   - postIssueComment(repo, n, body)  — returns the comment URL
 *   - addLabel / removeLabel (single)  — thin wrappers
 *   - addAssignees(repo, n, logins[])  — one --add-assignee per login
 *   - fetchIssueTimeline(repo, n)
 *   - fetchIssueComments(repo, n)
 *   - getCurrentUser()
 *
 * Everything goes through an injectable `CommandRunner` so tests can stub
 * gh entirely (no live calls).
 */
import { z } from 'zod';
import type { CommandRunner } from '@generacy-ai/cockpit';

function fail(op: string, result: { stderr: string; exitCode: number }): never {
  // Reason-only — the verb prefixes "Error: cockpit <verb>: <step>:" per cli-surface.md.
  const reason = result.stderr.trim() || `exit ${result.exitCode}`;
  throw new Error(`${op} (exit ${result.exitCode}): ${reason}`);
}

const LabelSchema = z.union([z.string(), z.object({ name: z.string() }).passthrough()]);

const IssueLabelsSchema = z.object({
  labels: z.array(LabelSchema).default([]),
});

const IssueStateSchema = z.object({
  state: z.string(),
  closedAt: z.string().nullable().optional(),
  labels: z.array(LabelSchema).default([]),
  assignees: z.array(z.object({ login: z.string() }).passthrough()).default([]),
  title: z.string().default(''),
});

const CommentSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  body: z.string().default(''),
  author: z
    .object({ login: z.string() })
    .passthrough()
    .nullable()
    .optional(),
  createdAt: z.string(),
  url: z.string().optional(),
});

const IssueCommentsSchema = z.object({
  comments: z.array(CommentSchema).default([]),
});

const TimelineEventSchema = z
  .object({
    event: z.string().optional(),
    created_at: z.string().optional(),
    label: z.object({ name: z.string() }).optional(),
  })
  .passthrough();

const UserSchema = z.object({ login: z.string() });

export interface IssueLabelsResult {
  labels: string[];
}

export interface IssueStateResult {
  state: 'OPEN' | 'CLOSED';
  closedAt: string | null;
  labels: string[];
  assignees: string[];
  title: string;
}

export interface IssueComment {
  body: string;
  author: string;
  createdAt: string;
  url: string;
}

export interface CockpitGh {
  fetchIssueLabels(repo: string, number: number): Promise<IssueLabelsResult>;
  fetchIssueState(repo: string, number: number): Promise<IssueStateResult>;
  postIssueComment(repo: string, number: number, body: string): Promise<{ url: string }>;
  addLabel(repo: string, number: number, label: string): Promise<void>;
  removeLabel(repo: string, number: number, label: string): Promise<void>;
  addAssignees(repo: string, number: number, logins: string[]): Promise<void>;
  fetchIssueTimeline(repo: string, number: number): Promise<unknown[]>;
  fetchIssueComments(repo: string, number: number): Promise<IssueComment[]>;
  getCurrentUser(): Promise<string>;
  /** Open PR url for a head branch on a given repo, or null. */
  findOpenPrForBranch(repo: string, branch: string): Promise<{ url: string; number: number } | null>;
  /** `gh pr diff --name-only` against the open PR (returns null if no PR). */
  prDiffNames(repo: string, prNumber: number): Promise<string[]>;
  /** `gh pr diff --patch` raw. */
  prDiffPatch(repo: string, prNumber: number): Promise<string>;
}

function normalizeLabels(arr: z.infer<typeof IssueLabelsSchema>['labels']): string[] {
  return arr.map((l) => (typeof l === 'string' ? l : l.name));
}

export function createCockpitGh(runner: CommandRunner): CockpitGh {
  return {
    async fetchIssueLabels(repo, number) {
      const res = await runner('gh', [
        'issue',
        'view',
        String(number),
        '--repo',
        repo,
        '--json',
        'labels',
      ]);
      if (res.exitCode !== 0) fail('issue view (labels)', res);
      const parsed = IssueLabelsSchema.safeParse(JSON.parse(res.stdout));
      if (!parsed.success) {
        throw new Error(`gh issue view returned unexpected JSON: ${parsed.error.message}`);
      }
      return { labels: normalizeLabels(parsed.data.labels) };
    },

    async fetchIssueState(repo, number) {
      const res = await runner('gh', [
        'issue',
        'view',
        String(number),
        '--repo',
        repo,
        '--json',
        'state,closedAt,labels,assignees,title',
      ]);
      if (res.exitCode !== 0) fail('issue view (state)', res);
      const parsed = IssueStateSchema.safeParse(JSON.parse(res.stdout));
      if (!parsed.success) {
        throw new Error(`gh issue view returned unexpected JSON: ${parsed.error.message}`);
      }
      return {
        state: parsed.data.state.toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
        closedAt: parsed.data.closedAt ?? null,
        labels: normalizeLabels(parsed.data.labels),
        assignees: parsed.data.assignees.map((a) => a.login),
        title: parsed.data.title,
      };
    },

    async postIssueComment(repo, number, body) {
      const res = await runner('gh', [
        'issue',
        'comment',
        String(number),
        '--repo',
        repo,
        '--body',
        body,
      ]);
      if (res.exitCode !== 0) fail('issue comment', res);
      const url = res.stdout.trim().split(/\s+/).pop() ?? '';
      return { url };
    },

    async addLabel(repo, number, label) {
      const res = await runner('gh', [
        'issue',
        'edit',
        String(number),
        '--repo',
        repo,
        '--add-label',
        label,
      ]);
      if (res.exitCode !== 0) fail('issue edit (add-label)', res);
    },

    async removeLabel(repo, number, label) {
      const res = await runner('gh', [
        'issue',
        'edit',
        String(number),
        '--repo',
        repo,
        '--remove-label',
        label,
      ]);
      if (res.exitCode !== 0) fail('issue edit (remove-label)', res);
    },

    async addAssignees(repo, number, logins) {
      for (const login of logins) {
        const res = await runner('gh', [
          'issue',
          'edit',
          String(number),
          '--repo',
          repo,
          '--add-assignee',
          login,
        ]);
        if (res.exitCode !== 0) fail('issue edit (add-assignee)', res);
      }
    },

    async fetchIssueTimeline(repo, number) {
      const res = await runner('gh', [
        'api',
        `repos/${repo}/issues/${number}/timeline`,
        '--header',
        'Accept: application/vnd.github+json',
        '--paginate',
      ]);
      if (res.exitCode !== 0) fail('api issues timeline', res);
      try {
        const parsed: unknown = JSON.parse(res.stdout);
        if (!Array.isArray(parsed)) {
          throw new Error('expected array');
        }
        return z.array(TimelineEventSchema).parse(parsed);
      } catch (err) {
        throw new Error(`gh api timeline returned non-array JSON: ${(err as Error).message}`);
      }
    },

    async fetchIssueComments(repo, number) {
      const res = await runner('gh', [
        'issue',
        'view',
        String(number),
        '--repo',
        repo,
        '--json',
        'comments',
      ]);
      if (res.exitCode !== 0) fail('issue view (comments)', res);
      const parsed = IssueCommentsSchema.safeParse(JSON.parse(res.stdout));
      if (!parsed.success) {
        throw new Error(`gh issue view comments returned unexpected JSON: ${parsed.error.message}`);
      }
      return parsed.data.comments.map((c) => ({
        body: c.body,
        author: c.author?.login ?? '',
        createdAt: c.createdAt,
        url: c.url ?? '',
      }));
    },

    async getCurrentUser() {
      const res = await runner('gh', ['api', 'user']);
      if (res.exitCode !== 0) fail('api user', res);
      const parsed = UserSchema.safeParse(JSON.parse(res.stdout));
      if (!parsed.success) {
        throw new Error(`gh api user returned unexpected JSON: ${parsed.error.message}`);
      }
      return parsed.data.login;
    },

    async findOpenPrForBranch(repo, branch) {
      const res = await runner('gh', [
        'pr',
        'list',
        '--repo',
        repo,
        '--head',
        branch,
        '--state',
        'open',
        '--json',
        'url,number',
        '--limit',
        '1',
      ]);
      if (res.exitCode !== 0) fail('pr list', res);
      const parsed = z
        .array(z.object({ url: z.string(), number: z.number() }))
        .safeParse(JSON.parse(res.stdout));
      if (!parsed.success || parsed.data.length === 0) return null;
      const first = parsed.data[0]!;
      return { url: first.url, number: first.number };
    },

    async prDiffNames(repo, prNumber) {
      const res = await runner('gh', [
        'pr',
        'diff',
        String(prNumber),
        '--repo',
        repo,
        '--name-only',
      ]);
      if (res.exitCode !== 0) fail('pr diff (name-only)', res);
      return res.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    },

    async prDiffPatch(repo, prNumber) {
      const res = await runner('gh', ['pr', 'diff', String(prNumber), '--repo', repo, '--patch']);
      if (res.exitCode !== 0) fail('pr diff (patch)', res);
      return res.stdout;
    },
  };
}
