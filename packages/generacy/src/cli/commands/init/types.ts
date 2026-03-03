import type { ClusterVariant } from '@generacy-ai/templates';

// ---------------------------------------------------------------------------
// Resolved init options — all values are concrete (no undefined)
// ---------------------------------------------------------------------------

/** Fully resolved options for the `generacy init` command. */
export interface InitOptions {
  /** Server-issued project ID, or a generated local placeholder. */
  projectId: string;

  /** Human-readable project display name. */
  projectName: string;

  /** Primary repository, normalized to `owner/repo` shorthand. */
  primaryRepo: string;

  /** Development repositories, each normalized to `owner/repo`. */
  devRepos: string[];

  /** Clone-only repositories, each normalized to `owner/repo`. */
  cloneRepos: string[];

  /** Default agent for task execution (e.g. `claude-code`). */
  agent: string;

  /** Default base branch for PRs (e.g. `main`). */
  baseBranch: string;

  /** Release stream: stable for production, preview for early access. */
  releaseStream: 'stable' | 'preview';

  /** Cluster variant: "standard" (DooD) or "microservices" (DinD). */
  variant: ClusterVariant;

  /** Overwrite all existing files without prompting. */
  force: boolean;

  /** Preview generated files without writing to disk. */
  dryRun: boolean;

  /** Skip GitHub API access validation. */
  skipGithubCheck: boolean;

  /** Accept all defaults without interactive prompts. */
  yes: boolean;
}

// ---------------------------------------------------------------------------
// File conflict resolution
// ---------------------------------------------------------------------------

/** Per-file conflict resolution action. */
export type FileAction = 'overwrite' | 'skip' | 'merge';

// ---------------------------------------------------------------------------
// File write result — used for the completion summary
// ---------------------------------------------------------------------------

/** Result of writing (or skipping) a single file. */
export interface FileResult {
  /** Relative path from the git root. */
  path: string;

  /** Action that was taken. */
  action: 'created' | 'overwritten' | 'merged' | 'skipped';

  /** Written file size in bytes (0 for skipped files). */
  size: number;
}

// ---------------------------------------------------------------------------
// GitHub access validation
// ---------------------------------------------------------------------------

/** Result of checking GitHub API access for a single repository. */
export interface RepoAccessResult {
  /** Repository in `owner/repo` format. */
  repo: string;

  /** Whether the repo exists and the token has read access. */
  accessible: boolean;

  /** Whether the token has push (write) access. */
  writable: boolean;

  /** Error message if the check failed (e.g. 404, 401). */
  error?: string;
}
