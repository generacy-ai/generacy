/**
 * Check prerequisites operation handler.
 * Wraps the prereqs library for workflow execution.
 */
import type { Logger } from '../../../../types/logger.js';
import type { CheckPrereqsInput, CheckPrereqsOutput } from '../types.js';
import { checkPrereqs } from '../lib/prereqs.js';

/**
 * Execute the check_prereqs operation
 */
export async function executeCheckPrereqs(
  input: CheckPrereqsInput,
  logger: Logger
): Promise<CheckPrereqsOutput> {
  logger.info('Checking prerequisites...');

  const result = await checkPrereqs(input);

  if (result.valid) {
    logger.info(`Prerequisites valid. Feature directory: ${result.featureDir}`);
    if (result.availableDocs.length > 0) {
      logger.info(`Available docs: ${result.availableDocs.join(', ')}`);
    }
  } else {
    logger.warn(`Prerequisites check failed: ${result.error}`);
    if (result.missingRequired) {
      logger.warn(`Missing required: ${result.missingRequired.join(', ')}`);
    }
  }

  return result;
}
