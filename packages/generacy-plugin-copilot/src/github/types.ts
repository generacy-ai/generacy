/**
 * @generacy-ai/generacy-plugin-copilot
 *
 * GitHub-specific type definitions.
 */

/**
 * GitHub issue data from API.
 */
export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

/**
 * GitHub pull request data from API.
 */
export interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
  head: {
    ref: string;
    sha: string;
  };
  base: {
    ref: string;
    sha: string;
  };
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  additions: number;
  deletions: number;
  changed_files: number;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
}

/**
 * GitHub file change from PR.
 */
export interface GitHubPRFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  previous_filename?: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  contents_url: string;
}

/**
 * GitHub review data.
 */
export interface GitHubReview {
  id: number;
  user: { login: string };
  state: 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  submitted_at: string;
}

/**
 * Parsed issue URL components.
 */
export interface ParsedIssueUrl {
  owner: string;
  repo: string;
  issueNumber: number;
}

/**
 * GitHub client configuration.
 */
export interface GitHubClientConfig {
  token: string;
  baseUrl?: string;
}
