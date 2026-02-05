/**
 * Create feature operation handler.
 * Wraps the feature library for workflow execution.
 */
import type { Logger } from '../../../../types/logger.js';
import type { CreateFeatureInput, CreateFeatureOutput } from '../types.js';
import { createFeature } from '../lib/feature.js';

/**
 * Execute the create_feature operation
 */
export async function executeCreateFeature(
  input: CreateFeatureInput,
  logger: Logger
): Promise<CreateFeatureOutput> {
  logger.info(`Creating feature from description: ${input.description.substring(0, 50)}...`);

  const result = await createFeature(input);

  if (result.success) {
    logger.info(`Feature created: ${result.branch_name}`);
    logger.info(`Feature directory: ${result.feature_dir}`);
    if (result.git_branch_created) {
      logger.info(`Git branch created: ${result.branch_name}`);
    }
    if (result.branched_from_epic) {
      logger.info(`Branched from epic: ${result.parent_epic_branch}`);
    }
  } else {
    logger.error('Failed to create feature');
  }

  return result;
}
