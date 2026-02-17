import type { GitHubClientFactory } from '@generacy-ai/workflow-engine';
import { WORKFLOW_LABELS } from '@generacy-ai/workflow-engine';

/**
 * Result of syncing a single label
 */
export interface LabelSyncResult {
  name: string;
  action: 'created' | 'updated' | 'unchanged';
}

/**
 * Result of syncing labels for a single repository
 */
export interface RepoSyncResult {
  owner: string;
  repo: string;
  success: boolean;
  created: number;
  updated: number;
  unchanged: number;
  error?: string;
  results: LabelSyncResult[];
}

/**
 * Result of syncing labels across all repositories
 */
export interface SyncAllResult {
  totalRepos: number;
  successfulRepos: number;
  failedRepos: number;
  results: RepoSyncResult[];
}

/**
 * Logger interface matching Pino/Fastify logger shape
 */
interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Service for syncing workflow labels across multiple repositories.
 * Ensures all configured repos have the correct set of label protocol labels.
 */
export class LabelSyncService {
  private readonly logger: Logger;
  private readonly createClient: GitHubClientFactory;
  private readonly syncedRepos: Set<string> = new Set();

  constructor(logger: Logger, createClient: GitHubClientFactory) {
    this.logger = logger;
    this.createClient = createClient;
  }

  /**
   * Sync labels for a single repository.
   * Lists existing labels, diffs against WORKFLOW_LABELS, creates/updates as needed.
   */
  async syncRepo(owner: string, repo: string): Promise<RepoSyncResult> {
    const client = this.createClient();
    const results: LabelSyncResult[] = [];
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    try {
      const existingLabels = await client.listLabels(owner, repo);
      const existingMap = new Map(existingLabels.map(l => [l.name, l]));

      for (const label of WORKFLOW_LABELS) {
        const existing = existingMap.get(label.name);

        if (!existing) {
          await client.createLabel(owner, repo, label.name, label.color, label.description);
          results.push({ name: label.name, action: 'created' });
          created++;
        } else if (existing.color !== label.color || existing.description !== label.description) {
          await client.updateLabel(owner, repo, label.name, {
            color: label.color,
            description: label.description,
          });
          results.push({ name: label.name, action: 'updated' });
          updated++;
        } else {
          results.push({ name: label.name, action: 'unchanged' });
          unchanged++;
        }
      }

      this.syncedRepos.add(`${owner}/${repo}`);

      return { owner, repo, success: true, created, updated, unchanged, results };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { owner, repo, success: false, created, updated, unchanged, error: errorMsg, results };
    }
  }

  /**
   * Sync labels for all provided repositories sequentially.
   * Per-repo errors are captured without failing the batch.
   */
  async syncAll(repos: Array<{ owner: string; repo: string }>): Promise<SyncAllResult> {
    const results: RepoSyncResult[] = [];
    let successfulRepos = 0;
    let failedRepos = 0;

    for (const { owner, repo } of repos) {
      const key = `${owner}/${repo}`;
      if (this.syncedRepos.has(key)) {
        this.logger.info(`Skipping already-synced repo: ${key}`);
        continue;
      }

      this.logger.info(`Syncing labels for ${key}...`);
      const result = await this.syncRepo(owner, repo);
      results.push(result);

      if (result.success) {
        successfulRepos++;
        this.logger.info(
          `${key}: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged`
        );
      } else {
        failedRepos++;
        this.logger.warn(`${key}: sync failed — ${result.error}`);
      }
    }

    return { totalRepos: repos.length, successfulRepos, failedRepos, results };
  }

  /**
   * Sync a new repo if not already tracked in this session.
   * Convenience method for the "new repo added" use case.
   */
  async syncNewRepo(owner: string, repo: string): Promise<RepoSyncResult | null> {
    const key = `${owner}/${repo}`;
    if (this.syncedRepos.has(key)) {
      this.logger.info(`Repo ${key} already synced in this session, skipping.`);
      return null;
    }

    return this.syncRepo(owner, repo);
  }

  /**
   * Force sync a repo, bypassing the tracking check.
   */
  async forceSync(owner: string, repo: string): Promise<RepoSyncResult> {
    return this.syncRepo(owner, repo);
  }

  /**
   * Reset the synced repos tracking set.
   */
  resetTracking(): void {
    this.syncedRepos.clear();
  }
}
