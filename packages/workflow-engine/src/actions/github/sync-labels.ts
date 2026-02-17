/**
 * github.sync_labels action - creates/updates GitHub labels from configuration.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  SyncLabelsInput,
  SyncLabelsOutput,
  LabelSyncResult,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from './client/index.js';
import { createGitHubClient } from './client/index.js';
import { WORKFLOW_LABELS, type LabelDefinition } from './label-definitions.js';

/**
 * github.sync_labels action handler
 */
export class SyncLabelsAction extends BaseAction {
  readonly type: ActionIdentifier = 'github.sync_labels';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'github.sync_labels' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const dryRun = this.getInput<boolean>(step, context, 'dry_run', true);

    context.logger.info(`Syncing labels (dry_run: ${dryRun})`);

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get repo info
      const repoInfo = await client.getRepoInfo();

      // Get existing labels
      const existingLabels = await client.listLabels(repoInfo.owner, repoInfo.repo);
      const existingMap = new Map(existingLabels.map(l => [l.name, l]));

      const results: LabelSyncResult[] = [];
      const created: string[] = [];
      const updated: string[] = [];
      const unchanged: string[] = [];

      // Process each configured label
      for (const labelConfig of WORKFLOW_LABELS) {
        const existing = existingMap.get(labelConfig.name);

        if (!existing) {
          // Create new label
          if (!dryRun) {
            await client.createLabel(
              repoInfo.owner,
              repoInfo.repo,
              labelConfig.name,
              labelConfig.color,
              labelConfig.description
            );
          }
          created.push(labelConfig.name);
          results.push({ name: labelConfig.name, action: 'created' });
          context.logger.info(`${dryRun ? '[DRY RUN] Would create' : 'Created'}: ${labelConfig.name}`);
        } else if (
          existing.color !== labelConfig.color ||
          existing.description !== labelConfig.description
        ) {
          // Update existing label
          if (!dryRun) {
            await client.updateLabel(
              repoInfo.owner,
              repoInfo.repo,
              labelConfig.name,
              {
                color: labelConfig.color,
                description: labelConfig.description,
              }
            );
          }
          updated.push(labelConfig.name);
          results.push({ name: labelConfig.name, action: 'updated' });
          context.logger.info(`${dryRun ? '[DRY RUN] Would update' : 'Updated'}: ${labelConfig.name}`);
        } else {
          // No change needed
          unchanged.push(labelConfig.name);
          results.push({ name: labelConfig.name, action: 'unchanged' });
        }
      }

      context.logger.info(
        `Sync complete: ${created.length} created, ${updated.length} updated, ${unchanged.length} unchanged`
      );

      const output: SyncLabelsOutput = {
        created,
        updated,
        unchanged,
        results,
      };

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
