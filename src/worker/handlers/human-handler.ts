/**
 * HumanHandler - Handles human job execution via the message router.
 */

import type { Job } from '../../scheduler/types.js';
import type {
  JobResult,
  HumanJobPayload,
  HumanJobResult,
  HumanHandlerConfig,
} from '../types.js';
import type { MessageRouter } from '../../router/message-router.js';
import type { MessageEnvelope } from '../../types/messages.js';
import { v4 as uuid } from 'uuid';

/**
 * Handler for human jobs - routes decisions to Humancy and waits for responses.
 */
export class HumanHandler {
  private router: MessageRouter;
  private config: HumanHandlerConfig;

  constructor(router: MessageRouter, config: HumanHandlerConfig) {
    this.router = router;
    this.config = config;
  }

  /**
   * Handle a human job by routing to Humancy and waiting for response.
   */
  async handle(job: Job): Promise<JobResult> {
    const startTime = Date.now();
    const payload = job.payload as HumanJobPayload;

    // Validate required fields
    if (!payload.type || !payload.title || !payload.description) {
      throw new Error('Invalid human job payload: missing required fields');
    }

    // Generate correlation ID for tracking
    const correlationId = `${job.id}-${uuid()}`;

    // Build the decision request message
    const message: MessageEnvelope = {
      id: uuid(),
      correlationId,
      type: 'decision_request',
      source: { type: 'agency', id: 'worker' },
      destination: { type: 'humancy', id: 'default' },
      payload: {
        type: payload.type,
        title: payload.title,
        description: payload.description,
        options: payload.options,
        assignee: payload.assignee,
        urgency: payload.urgency,
        workflowId: job.workflowId,
        stepId: job.stepId,
      },
      meta: { timestamp: Date.now() },
    };

    // Determine timeout
    const timeout = payload.timeout ?? this.config.defaultTimeout;

    try {
      // Route message and wait for response
      const response = await this.router.routeAndWait(message, timeout);

      const duration = Date.now() - startTime;

      // Convert response to HumanJobResult
      const responsePayload = response.payload as {
        approved?: boolean;
        decision?: string;
        input?: string;
        respondedBy: string;
        respondedAt: string;
      };

      const result: HumanJobResult = {
        success: true,
        output: {
          approved: responsePayload.approved,
          decision: responsePayload.decision,
          input: responsePayload.input,
          respondedBy: responsePayload.respondedBy,
          respondedAt: responsePayload.respondedAt,
        },
        duration,
        metadata: {
          correlationId,
          type: payload.type,
        },
      };

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Check if this is a timeout error
      if (error instanceof Error && error.name === 'CorrelationTimeoutError') {
        // Handle based on timeoutAction config
        if (this.config.timeoutAction === 'fail' || !payload.escalation) {
          return {
            success: false,
            output: {},
            duration,
            metadata: {
              error: 'Human decision timeout',
              correlationId,
            },
          };
        }

        // Handle escalation (simplified - just fail for now)
        return {
          success: false,
          output: {},
          duration,
          metadata: {
            error: 'Human decision timeout after escalation',
            correlationId,
            escalationAttempts: 1,
          },
        };
      }

      // Check if cancelled
      if (error instanceof Error && error.name === 'CorrelationCancelledError') {
        return {
          success: false,
          output: {},
          duration,
          metadata: {
            cancelled: true,
            correlationId,
          },
        };
      }

      // Generic error
      return {
        success: false,
        output: {},
        duration,
        metadata: {
          error: error instanceof Error ? error.message : String(error),
          correlationId,
        },
      };
    }
  }
}
