/**
 * Copy template operation handler.
 * Wraps the templates library for workflow execution.
 */
import type { Logger } from '../../../../types/logger.js';
import type { CopyTemplateInput, CopyTemplateOutput } from '../types.js';
import { copyTemplates } from '../lib/templates.js';

/**
 * Execute the copy_template operation
 */
export async function executeCopyTemplate(
  input: CopyTemplateInput,
  logger: Logger
): Promise<CopyTemplateOutput> {
  logger.info(`Copying templates: ${input.templates.join(', ')}`);

  const result = await copyTemplates(input);

  if (result.success) {
    for (const copied of result.copied) {
      logger.info(`Copied ${copied.template} to ${copied.destPath}`);
    }
  } else {
    logger.error('Template copy failed');
    if (result.errors) {
      for (const error of result.errors) {
        logger.error(`${error.template}: ${error.error.message}`);
      }
    }
  }

  return result;
}
