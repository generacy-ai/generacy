/**
 * GitHubClient implementation using the gh CLI.
 * Uses the GitHub CLI for all GitHub API operations and git for local operations.
 */
import type {
  GitHubClient,
  IssueUpdate,
  PRCreate,
  PRUpdate,
  MergeResult,
  CommitResult,
  PushResult,
  GitStatus,
  LabelDefinition,
} from './interface.js';
import type {
  Issue,
  PullRequest,
  Comment,
  Label,
  RepoInfo,
  ConflictInfo,
} from '../../../types/github.js';
import { executeCommand, parseJSONSafe } from '../../cli-utils.js';

/**
 * GitHubClient implementation using gh CLI and git commands
 */
export class GhCliGitHubClient implements GitHubClient {
  private workdir: string;

  constructor(workdir?: string) {
    this.workdir = workdir ?? process.cwd();
  }

  // ==========================================================================
  // Repository Info
  // ==========================================================================

  async getRepoInfo(): Promise<RepoInfo> {
    const result = await executeCommand('gh', [
      'repo', 'view',
      '--json', 'owner,name,defaultBranchRef',
    ], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get repo info: ${result.stderr}`);
    }

    const data = parseJSONSafe(result.stdout) as {
      owner: { login: string };
      name: string;
      defaultBranchRef: { name: string };
    } | null;

    if (!data) {
      throw new Error('Failed to parse repo info');
    }

    return {
      owner: data.owner.login,
      repo: data.name,
      default_branch: data.defaultBranchRef.name,
    };
  }

  // ==========================================================================
  // Issue Operations
  // ==========================================================================

  async getIssue(owner: string, repo: string, number: number): Promise<Issue> {
    const result = await executeCommand('gh', [
      'issue', 'view', String(number),
      '-R', `${owner}/${repo}`,
      '--json', 'number,title,body,state,labels,assignees,milestone,createdAt,updatedAt',
    ], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get issue #${number}: ${result.stderr}`);
    }

    const data = parseJSONSafe(result.stdout) as Record<string, unknown> | null;
    if (!data) {
      throw new Error('Failed to parse issue data');
    }

    return {
      number: data['number'] as number,
      title: data['title'] as string,
      body: data['body'] as string ?? '',
      state: (data['state'] as string).toLowerCase() as 'open' | 'closed',
      labels: ((data['labels'] as Array<{ name: string; color: string; description?: string }>) ?? []).map(l => ({
        name: l.name,
        color: l.color,
        description: l.description,
      })),
      assignees: ((data['assignees'] as Array<{ login: string }>) ?? []).map(a => a.login),
      milestone: data['milestone'] ? {
        number: (data['milestone'] as { number: number }).number,
        title: (data['milestone'] as { title: string }).title,
        state: 'open' as const,
      } : undefined,
      created_at: data['createdAt'] as string,
      updated_at: data['updatedAt'] as string,
    };
  }

  async updateIssue(owner: string, repo: string, number: number, data: IssueUpdate): Promise<void> {
    const args = ['issue', 'edit', String(number), '-R', `${owner}/${repo}`];

    if (data.title) {
      args.push('--title', data.title);
    }
    if (data.body !== undefined) {
      args.push('--body', data.body);
    }
    if (data.labels) {
      // Clear existing labels and add new ones
      args.push('--remove-label', '*');
      for (const label of data.labels) {
        args.push('--add-label', label);
      }
    }
    if (data.assignees) {
      for (const assignee of data.assignees) {
        args.push('--add-assignee', assignee);
      }
    }

    const result = await executeCommand('gh', args, { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to update issue #${number}: ${result.stderr}`);
    }
  }

  async addIssueComment(owner: string, repo: string, number: number, body: string): Promise<Comment> {
    const result = await executeCommand('gh', [
      'issue', 'comment', String(number),
      '-R', `${owner}/${repo}`,
      '--body', body,
    ], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to add comment to issue #${number}: ${result.stderr}`);
    }

    // gh doesn't return the comment details, so we need to fetch the latest comment
    const comments = await this.getIssueComments(owner, repo, number);
    const latest = comments[comments.length - 1];
    if (!latest) {
      throw new Error('Failed to get created comment');
    }
    return latest;
  }

  async getIssueComments(owner: string, repo: string, number: number): Promise<Comment[]> {
    const result = await executeCommand('gh', [
      'issue', 'view', String(number),
      '-R', `${owner}/${repo}`,
      '--json', 'comments',
    ], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get comments for issue #${number}: ${result.stderr}`);
    }

    const data = parseJSONSafe(result.stdout) as { comments: Array<{
      id: string;
      body: string;
      author: { login: string };
      createdAt: string;
      updatedAt: string;
    }> } | null;

    if (!data) {
      return [];
    }

    return data.comments.map(c => ({
      id: parseInt(c.id.split('/').pop() ?? '0', 10),
      body: c.body,
      author: c.author.login,
      created_at: c.createdAt,
      updated_at: c.updatedAt,
    }));
  }

  async updateComment(owner: string, repo: string, commentId: number, body: string): Promise<void> {
    // gh CLI doesn't have a direct command to edit comments, use API
    const result = await executeCommand('gh', [
      'api',
      '-X', 'PATCH',
      `/repos/${owner}/${repo}/issues/comments/${commentId}`,
      '-f', `body=${body}`,
    ], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to update comment ${commentId}: ${result.stderr}`);
    }
  }

  // ==========================================================================
  // PR Operations
  // ==========================================================================

  async createPullRequest(owner: string, repo: string, data: PRCreate): Promise<PullRequest> {
    const args = [
      'pr', 'create',
      '-R', `${owner}/${repo}`,
      '--title', data.title,
      '--body', data.body ?? '',
      '--head', data.head,
      '--base', data.base,
    ];

    if (data.draft) {
      args.push('--draft');
    }

    // Add JSON output for details
    args.push('--json', 'number,url,state,headRefName,baseRefName,isDraft,title,body,createdAt,updatedAt');

    const result = await executeCommand('gh', args, { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create PR: ${result.stderr}`);
    }

    const parsed = parseJSONSafe(result.stdout) as Record<string, unknown> | null;
    if (!parsed) {
      // Try to extract URL from output
      const urlMatch = result.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
      if (urlMatch) {
        return {
          number: parseInt(urlMatch[1]!, 10),
          title: data.title,
          body: data.body ?? '',
          state: data.draft ? 'open' : 'open',
          draft: data.draft ?? false,
          head: { ref: data.head, sha: '', repo: `${owner}/${repo}` },
          base: { ref: data.base, sha: '', repo: `${owner}/${repo}` },
          labels: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      }
      throw new Error('Failed to parse PR creation response');
    }

    return {
      number: parsed['number'] as number,
      title: parsed['title'] as string,
      body: parsed['body'] as string ?? '',
      state: 'open',
      draft: parsed['isDraft'] as boolean ?? false,
      head: { ref: parsed['headRefName'] as string, sha: '', repo: `${owner}/${repo}` },
      base: { ref: parsed['baseRefName'] as string, sha: '', repo: `${owner}/${repo}` },
      labels: [],
      created_at: parsed['createdAt'] as string,
      updated_at: parsed['updatedAt'] as string,
    };
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<PullRequest> {
    const result = await executeCommand('gh', [
      'pr', 'view', String(number),
      '-R', `${owner}/${repo}`,
      '--json', 'number,title,body,state,isDraft,headRefName,baseRefName,labels,mergeable,createdAt,updatedAt',
    ], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get PR #${number}: ${result.stderr}`);
    }

    const data = parseJSONSafe(result.stdout) as Record<string, unknown> | null;
    if (!data) {
      throw new Error('Failed to parse PR data');
    }

    const state = (data['state'] as string).toLowerCase();

    return {
      number: data['number'] as number,
      title: data['title'] as string,
      body: data['body'] as string ?? '',
      state: state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open',
      draft: data['isDraft'] as boolean ?? false,
      head: { ref: data['headRefName'] as string, sha: '', repo: `${owner}/${repo}` },
      base: { ref: data['baseRefName'] as string, sha: '', repo: `${owner}/${repo}` },
      labels: ((data['labels'] as Array<{ name: string; color: string }>) ?? []).map(l => ({
        name: l.name,
        color: l.color,
      })),
      mergeable: data['mergeable'] as boolean,
      created_at: data['createdAt'] as string,
      updated_at: data['updatedAt'] as string,
    };
  }

  async updatePullRequest(owner: string, repo: string, number: number, data: PRUpdate): Promise<void> {
    const args = ['pr', 'edit', String(number), '-R', `${owner}/${repo}`];

    if (data.title) {
      args.push('--title', data.title);
    }
    if (data.body !== undefined) {
      args.push('--body', data.body);
    }

    const result = await executeCommand('gh', args, { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to update PR #${number}: ${result.stderr}`);
    }

    // Handle state change separately
    if (data.state === 'closed') {
      const closeResult = await executeCommand('gh', [
        'pr', 'close', String(number),
        '-R', `${owner}/${repo}`,
      ], { cwd: this.workdir });
      if (closeResult.exitCode !== 0) {
        throw new Error(`Failed to close PR #${number}: ${closeResult.stderr}`);
      }
    }
  }

  async markPRReady(owner: string, repo: string, number: number): Promise<void> {
    const result = await executeCommand('gh', [
      'pr', 'ready', String(number),
      '-R', `${owner}/${repo}`,
    ], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to mark PR #${number} as ready: ${result.stderr}`);
    }
  }

  async getPRComments(owner: string, repo: string, number: number): Promise<Comment[]> {
    // Get review comments using API
    const result = await executeCommand('gh', [
      'api',
      `/repos/${owner}/${repo}/pulls/${number}/comments`,
      '--jq', '.[] | {id: .id, body: .body, author: .user.login, path: .path, line: .line, in_reply_to_id: .in_reply_to_id, created_at: .created_at, updated_at: .updated_at}',
    ], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      // No comments is not an error
      return [];
    }

    const lines = result.stdout.trim().split('\n').filter(l => l);
    const comments: Comment[] = [];
    for (const line of lines) {
      const data = parseJSONSafe(line) as Record<string, unknown> | null;
      if (!data) continue;
      comments.push({
        id: data['id'] as number,
        body: data['body'] as string,
        author: data['author'] as string,
        path: data['path'] as string | undefined,
        line: data['line'] as number | undefined,
        in_reply_to_id: data['in_reply_to_id'] as number | undefined,
        created_at: data['created_at'] as string,
        updated_at: data['updated_at'] as string,
      });
    }
    return comments;
  }

  async replyToPRComment(owner: string, repo: string, number: number, commentId: number, body: string): Promise<Comment> {
    const result = await executeCommand('gh', [
      'api',
      '-X', 'POST',
      `/repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`,
      '-f', `body=${body}`,
    ], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to reply to comment ${commentId}: ${result.stderr}`);
    }

    const data = parseJSONSafe(result.stdout) as Record<string, unknown> | null;
    if (!data) {
      throw new Error('Failed to parse reply response');
    }

    return {
      id: data['id'] as number,
      body: data['body'] as string,
      author: (data['user'] as { login: string }).login,
      created_at: data['created_at'] as string,
      updated_at: data['updated_at'] as string,
    };
  }

  async findPRForBranch(owner: string, repo: string, branch: string): Promise<PullRequest | null> {
    const result = await executeCommand('gh', [
      'pr', 'list',
      '-R', `${owner}/${repo}`,
      '--head', branch,
      '--json', 'number,title,body,state,isDraft,headRefName,baseRefName,labels,createdAt,updatedAt',
      '--limit', '1',
    ], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      return null;
    }

    const data = parseJSONSafe(result.stdout) as Array<Record<string, unknown>> | null;
    if (!data || data.length === 0) {
      return null;
    }

    const pr = data[0]!;
    return {
      number: pr['number'] as number,
      title: pr['title'] as string,
      body: pr['body'] as string ?? '',
      state: (pr['state'] as string).toLowerCase() === 'merged' ? 'merged' : 'open',
      draft: pr['isDraft'] as boolean ?? false,
      head: { ref: pr['headRefName'] as string, sha: '', repo: `${owner}/${repo}` },
      base: { ref: pr['baseRefName'] as string, sha: '', repo: `${owner}/${repo}` },
      labels: ((pr['labels'] as Array<{ name: string; color: string }>) ?? []).map(l => ({
        name: l.name,
        color: l.color,
      })),
      created_at: pr['createdAt'] as string,
      updated_at: pr['updatedAt'] as string,
    };
  }

  // ==========================================================================
  // Label Operations
  // ==========================================================================

  async addLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;

    const args = ['issue', 'edit', String(number), '-R', `${owner}/${repo}`];
    for (const label of labels) {
      args.push('--add-label', label);
    }

    const result = await executeCommand('gh', args, { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to add labels: ${result.stderr}`);
    }
  }

  async removeLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;

    const args = ['issue', 'edit', String(number), '-R', `${owner}/${repo}`];
    for (const label of labels) {
      args.push('--remove-label', label);
    }

    const result = await executeCommand('gh', args, { cwd: this.workdir });
    if (result.exitCode !== 0) {
      // Label might not exist, don't fail
      if (!result.stderr.includes('not found')) {
        throw new Error(`Failed to remove labels: ${result.stderr}`);
      }
    }
  }

  async getRepoLabels(owner: string, repo: string): Promise<Label[]> {
    const result = await executeCommand('gh', [
      'label', 'list',
      '-R', `${owner}/${repo}`,
      '--json', 'name,color,description',
      '--limit', '1000',
    ], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get labels: ${result.stderr}`);
    }

    const data = parseJSONSafe(result.stdout) as Array<{
      name: string;
      color: string;
      description?: string;
    }> | null;

    return data ?? [];
  }

  async createOrUpdateLabel(owner: string, repo: string, label: LabelDefinition): Promise<{ created: boolean }> {
    // Check if label exists
    const existing = await this.getRepoLabels(owner, repo);
    const exists = existing.some(l => l.name === label.name);

    if (exists) {
      // Update
      const args = [
        'label', 'edit', label.name,
        '-R', `${owner}/${repo}`,
        '--color', label.color.replace('#', ''),
      ];
      if (label.description) {
        args.push('--description', label.description);
      }

      const result = await executeCommand('gh', args, { cwd: this.workdir });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to update label ${label.name}: ${result.stderr}`);
      }
      return { created: false };
    } else {
      // Create
      const args = [
        'label', 'create', label.name,
        '-R', `${owner}/${repo}`,
        '--color', label.color.replace('#', ''),
      ];
      if (label.description) {
        args.push('--description', label.description);
      }

      const result = await executeCommand('gh', args, { cwd: this.workdir });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to create label ${label.name}: ${result.stderr}`);
      }
      return { created: true };
    }
  }

  // ==========================================================================
  // Git Operations (Local)
  // ==========================================================================

  async getStatus(): Promise<GitStatus> {
    const branchResult = await executeCommand('git', ['branch', '--show-current'], { cwd: this.workdir });
    const branch = branchResult.stdout.trim();

    const statusResult = await executeCommand('git', ['status', '--porcelain'], { cwd: this.workdir });
    const lines = statusResult.stdout.split('\n').filter(l => l);

    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    for (const line of lines) {
      const indexStatus = line[0];
      const workingStatus = line[1];
      const file = line.substring(3);

      if (indexStatus === '?' && workingStatus === '?') {
        untracked.push(file);
      } else {
        if (indexStatus && indexStatus !== ' ' && indexStatus !== '?') {
          staged.push(file);
        }
        if (workingStatus && workingStatus !== ' ' && workingStatus !== '?') {
          unstaged.push(file);
        }
      }
    }

    return {
      branch,
      has_changes: lines.length > 0,
      staged,
      unstaged,
      untracked,
    };
  }

  async getCurrentBranch(): Promise<string> {
    const result = await executeCommand('git', ['branch', '--show-current'], { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to get current branch: ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  async branchExists(branch: string, remote = false): Promise<boolean> {
    if (remote) {
      const result = await executeCommand('git', ['ls-remote', '--heads', 'origin', branch], { cwd: this.workdir });
      return result.stdout.includes(branch);
    } else {
      const result = await executeCommand('git', ['branch', '--list', branch], { cwd: this.workdir });
      return result.stdout.trim().length > 0;
    }
  }

  async createBranch(name: string, startPoint?: string): Promise<void> {
    const args = ['checkout', '-b', name];
    if (startPoint) {
      args.push(startPoint);
    }

    const result = await executeCommand('git', args, { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create branch ${name}: ${result.stderr}`);
    }
  }

  async checkout(branch: string): Promise<void> {
    const result = await executeCommand('git', ['checkout', branch], { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to checkout ${branch}: ${result.stderr}`);
    }
  }

  async stageFiles(files: string[]): Promise<void> {
    if (files.length === 0) return;

    const result = await executeCommand('git', ['add', ...files], { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to stage files: ${result.stderr}`);
    }
  }

  async stageAll(): Promise<void> {
    const result = await executeCommand('git', ['add', '-A'], { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to stage all: ${result.stderr}`);
    }
  }

  async commit(message: string): Promise<CommitResult> {
    const result = await executeCommand('git', ['commit', '-m', message], { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to commit: ${result.stderr}`);
    }

    // Get the commit SHA
    const shaResult = await executeCommand('git', ['rev-parse', 'HEAD'], { cwd: this.workdir });
    const sha = shaResult.stdout.trim();

    // Get committed files
    const diffResult = await executeCommand('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], { cwd: this.workdir });
    const files = diffResult.stdout.split('\n').filter(f => f);

    return {
      sha,
      files_committed: files,
    };
  }

  async push(remote = 'origin', branch?: string, setUpstream = false): Promise<PushResult> {
    const currentBranch = branch ?? await this.getCurrentBranch();
    const args = ['push', remote, currentBranch];

    if (setUpstream) {
      args.splice(1, 0, '-u');
    }

    const result = await executeCommand('git', args, { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to push: ${result.stderr}`);
    }

    return {
      success: true,
      ref: currentBranch,
      remote,
    };
  }

  async fetch(remote = 'origin', prune = true): Promise<void> {
    const args = ['fetch', remote];
    if (prune) {
      args.push('--prune');
    }

    const result = await executeCommand('git', args, { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to fetch: ${result.stderr}`);
    }
  }

  async merge(branch: string, noCommit = false): Promise<MergeResult> {
    const args = ['merge', branch];
    if (noCommit) {
      args.push('--no-commit');
    }

    const result = await executeCommand('git', args, { cwd: this.workdir });

    // Check for conflicts
    if (result.exitCode !== 0 && result.stdout.includes('CONFLICT')) {
      const conflicted = await this.getConflictedFiles();
      const conflicts: ConflictInfo[] = conflicted.map(path => ({
        path,
        ours: '',
        theirs: '',
        resolved: false,
      }));

      return {
        success: false,
        commits_merged: 0,
        already_up_to_date: false,
        conflicts,
        summary: `Merge conflict in ${conflicts.length} file(s)`,
      };
    }

    if (result.exitCode !== 0) {
      throw new Error(`Failed to merge ${branch}: ${result.stderr}`);
    }

    // Check if already up to date
    if (result.stdout.includes('Already up to date')) {
      return {
        success: true,
        commits_merged: 0,
        already_up_to_date: true,
        conflicts: [],
        summary: 'Already up to date',
      };
    }

    // Count commits merged (rough estimate from output)
    const commitMatch = result.stdout.match(/(\d+) files? changed/);
    const filesChanged = commitMatch ? parseInt(commitMatch[1]!, 10) : 0;

    return {
      success: true,
      commits_merged: filesChanged > 0 ? 1 : 0,
      already_up_to_date: false,
      conflicts: [],
      summary: result.stdout.trim().split('\n')[0] ?? 'Merge completed',
    };
  }

  async mergeAbort(): Promise<void> {
    const result = await executeCommand('git', ['merge', '--abort'], { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to abort merge: ${result.stderr}`);
    }
  }

  async stash(message?: string): Promise<boolean> {
    const args = ['stash', 'push'];
    if (message) {
      args.push('-m', message);
    }

    const result = await executeCommand('git', args, { cwd: this.workdir });
    // Returns true if something was stashed
    return !result.stdout.includes('No local changes to save');
  }

  async stashPop(): Promise<{ success: boolean; conflicts: boolean }> {
    const result = await executeCommand('git', ['stash', 'pop'], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      if (result.stderr.includes('CONFLICT')) {
        return { success: false, conflicts: true };
      }
      throw new Error(`Failed to pop stash: ${result.stderr}`);
    }

    return { success: true, conflicts: false };
  }

  async getConflictedFiles(): Promise<string[]> {
    const result = await executeCommand('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: this.workdir });
    return result.stdout.split('\n').filter(f => f);
  }

  async getDefaultBranch(): Promise<string> {
    // Try to get from remote
    const result = await executeCommand('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: this.workdir });
    if (result.exitCode === 0) {
      return result.stdout.trim().replace('refs/remotes/origin/', '');
    }

    // Fallback to checking common names
    for (const branch of ['develop', 'main', 'master']) {
      const exists = await this.branchExists(branch, true);
      if (exists) return branch;
    }

    return 'main';
  }

  async getCommitsBetween(base: string, head: string): Promise<{ sha: string; message: string }[]> {
    const result = await executeCommand('git', [
      'log', `${base}..${head}`,
      '--format=%H|%s',
    ], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      return [];
    }

    return result.stdout.split('\n').filter(l => l).map(line => {
      const [sha, ...messageParts] = line.split('|');
      return {
        sha: sha ?? '',
        message: messageParts.join('|'),
      };
    });
  }

  // ==========================================================================
  // Alias Methods (convenience wrappers)
  // ==========================================================================

  async listBranches(owner: string, repo: string): Promise<string[]> {
    // List remote branches using gh api
    const result = await executeCommand('gh', [
      'api',
      `/repos/${owner}/${repo}/branches`,
      '--jq', '.[].name',
    ], { cwd: this.workdir });

    if (result.exitCode !== 0) {
      // Fallback to git
      const gitResult = await executeCommand('git', [
        'branch', '-r', '--format=%(refname:short)',
      ], { cwd: this.workdir });
      return gitResult.stdout.split('\n')
        .filter(b => b)
        .map(b => b.replace('origin/', ''));
    }

    return result.stdout.split('\n').filter(b => b);
  }

  async createPR(owner: string, repo: string, data: PRCreate): Promise<PullRequest> {
    return this.createPullRequest(owner, repo, data);
  }

  async updatePR(owner: string, repo: string, number: number, data: PRUpdate): Promise<void> {
    return this.updatePullRequest(owner, repo, number, data);
  }

  async getPRForBranch(owner: string, repo: string, branch: string): Promise<PullRequest | null> {
    return this.findPRForBranch(owner, repo, branch);
  }

  async listLabels(owner: string, repo: string): Promise<Label[]> {
    return this.getRepoLabels(owner, repo);
  }

  async createLabel(owner: string, repo: string, name: string, color: string, description?: string): Promise<void> {
    await this.createOrUpdateLabel(owner, repo, { name, color, description });
  }

  async updateLabel(owner: string, repo: string, name: string, data: { color?: string; description?: string }): Promise<void> {
    const args = ['label', 'edit', name, '-R', `${owner}/${repo}`];

    if (data.color) {
      args.push('--color', data.color.replace('#', ''));
    }
    if (data.description !== undefined) {
      args.push('--description', data.description);
    }

    const result = await executeCommand('gh', args, { cwd: this.workdir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to update label ${name}: ${result.stderr}`);
    }
  }
}
