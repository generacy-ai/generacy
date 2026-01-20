/**
 * IntegrationHandler - Handles integration job execution.
 */

import type { Job } from '../../scheduler/types.js';
import type {
  IntegrationJobPayload,
  IntegrationJobResult,
  IntegrationHandlerConfig,
} from '../types.js';

/**
 * Integration plugin interface.
 */
export interface IntegrationPlugin {
  execute(
    action: string,
    params: Record<string, unknown>
  ): Promise<{ output: unknown; statusCode?: number }>;
}

/**
 * Handler for integration jobs - calls external service APIs.
 */
export class IntegrationHandler {
  private integrations: Map<string, IntegrationPlugin>;
  private config: IntegrationHandlerConfig;

  constructor(
    integrations: Map<string, IntegrationPlugin>,
    config: IntegrationHandlerConfig
  ) {
    this.integrations = integrations;
    this.config = config;
  }

  /**
   * Handle an integration job by executing the appropriate plugin.
   */
  async handle(job: Job): Promise<IntegrationJobResult> {
    const payload = job.payload as IntegrationJobPayload;
    const { integration, action, params, timeout } = payload;

    const plugin = this.integrations.get(integration);
    if (!plugin) {
      throw new Error(`Integration not found: ${integration}`);
    }

    const effectiveTimeout = timeout ?? this.config.defaultTimeout;

    try {
      const result = await Promise.race([
        plugin.execute(action, params),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Integration timeout')), effectiveTimeout);
        }),
      ]);

      return {
        success: true,
        output: result.output,
        statusCode: result.statusCode,
      };
    } catch (error) {
      // Re-throw timeout and other errors
      throw error;
    }
  }
}
