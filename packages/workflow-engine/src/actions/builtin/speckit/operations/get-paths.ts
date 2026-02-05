/**
 * Get paths operation handler.
 * Wraps the paths library for workflow execution.
 */
import type { Logger } from '../../../../types/logger.js';
import type { GetPathsInput, GetPathsOutput } from '../types.js';
import { getPaths } from '../lib/paths.js';

/**
 * Execute the get_paths operation
 */
export async function executeGetPaths(
  input: GetPathsInput,
  logger: Logger
): Promise<GetPathsOutput> {
  logger.info(`Getting paths for branch: ${input.branch || '(auto-detect)'}`);

  const result = await getPaths(input);

  if (result.success) {
    logger.info(`Feature directory: ${result.featureDir}`);
    logger.info(`Feature exists: ${result.exists}`);
  } else {
    logger.error('Failed to get paths');
  }

  return result;
}
