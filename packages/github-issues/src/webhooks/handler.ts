import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TypedWebhookEvent, WorkflowAction } from '../types/index.js';
import { WebhookVerificationError, GitHubValidationError } from '../utils/errors.js';
import { parseWebhookEvent, isSupportedEvent } from './parser.js';
import { evaluateTriggers, type TriggerConfig } from './triggers.js';

/**
 * Webhook handler configuration
 */
export interface WebhookHandlerConfig extends TriggerConfig {
  /** Webhook secret for signature verification */
  webhookSecret?: string;
}

/**
 * Webhook delivery headers
 */
export interface WebhookHeaders {
  /** Event type (X-GitHub-Event) */
  'x-github-event'?: string;

  /** Delivery ID (X-GitHub-Delivery) */
  'x-github-delivery'?: string;

  /** HMAC signature (X-Hub-Signature-256) */
  'x-hub-signature-256'?: string;
}

/**
 * Result of webhook processing
 */
export interface WebhookResult {
  /** Whether the webhook was processed successfully */
  success: boolean;

  /** The resulting workflow action */
  action: WorkflowAction;

  /** The parsed event (if successful) */
  event?: TypedWebhookEvent;

  /** Error message (if failed) */
  error?: string;
}

/**
 * Verify webhook signature using HMAC SHA-256
 */
function verifySignature(
  payload: string | Buffer,
  signature: string,
  secret: string
): boolean {
  const expected = `sha256=${createHmac('sha256', secret)
    .update(payload)
    .digest('hex')}`;

  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

/**
 * Webhook event handler
 */
export class WebhookHandler {
  private readonly config: WebhookHandlerConfig;

  constructor(config: WebhookHandlerConfig) {
    this.config = config;
  }

  /**
   * Verify the webhook signature
   * @throws WebhookVerificationError if verification fails
   */
  verifySignature(payload: string | Buffer, signature: string): void {
    if (!this.config.webhookSecret) {
      // No secret configured, skip verification
      return;
    }

    if (!signature) {
      throw new WebhookVerificationError('Missing webhook signature');
    }

    if (!verifySignature(payload, signature, this.config.webhookSecret)) {
      throw new WebhookVerificationError('Invalid webhook signature');
    }
  }

  /**
   * Process a raw webhook delivery
   */
  async processRaw(
    headers: WebhookHeaders,
    body: string | Buffer,
    rawPayload?: unknown
  ): Promise<WebhookResult> {
    const eventName = headers['x-github-event'];
    const deliveryId = headers['x-github-delivery'];
    const signature = headers['x-hub-signature-256'];

    // Verify signature if configured
    if (this.config.webhookSecret && signature) {
      try {
        this.verifySignature(body, signature);
      } catch (error) {
        return {
          success: false,
          action: { type: 'no_action', reason: 'Signature verification failed' },
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }

    // Validate event type
    if (!eventName) {
      return {
        success: false,
        action: { type: 'no_action', reason: 'Missing event type header' },
        error: 'Missing X-GitHub-Event header',
      };
    }

    // Check if event is supported
    if (!isSupportedEvent(eventName)) {
      return {
        success: true, // Not an error, just not handled
        action: { type: 'no_action', reason: `Unsupported event type: ${eventName}` },
      };
    }

    // Parse the payload
    let payload: unknown;
    if (rawPayload !== undefined) {
      payload = rawPayload;
    } else if (typeof body === 'string') {
      try {
        payload = JSON.parse(body);
      } catch {
        return {
          success: false,
          action: { type: 'no_action', reason: 'Invalid JSON payload' },
          error: 'Failed to parse webhook payload as JSON',
        };
      }
    } else {
      try {
        payload = JSON.parse(body.toString('utf-8'));
      } catch {
        return {
          success: false,
          action: { type: 'no_action', reason: 'Invalid JSON payload' },
          error: 'Failed to parse webhook payload as JSON',
        };
      }
    }

    // Parse and evaluate the event
    try {
      const event = parseWebhookEvent(eventName, payload, deliveryId);
      const action = evaluateTriggers(event, this.config);

      return {
        success: true,
        action,
        event,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        action: { type: 'no_action', reason: `Failed to process event: ${message}` },
        error: message,
      };
    }
  }

  /**
   * Process a pre-parsed webhook event
   */
  async processEvent(event: TypedWebhookEvent): Promise<WebhookResult> {
    try {
      const action = evaluateTriggers(event, this.config);
      return {
        success: true,
        action,
        event,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        action: { type: 'no_action', reason: `Failed to process event: ${message}` },
        error: message,
      };
    }
  }

  /**
   * Handle a webhook delivery (convenience method)
   * Returns the workflow action or null if no action needed
   */
  async handle(
    eventName: string,
    payload: unknown,
    deliveryId?: string
  ): Promise<WorkflowAction> {
    if (!isSupportedEvent(eventName)) {
      return { type: 'no_action', reason: `Unsupported event type: ${eventName}` };
    }

    try {
      const event = parseWebhookEvent(eventName, payload, deliveryId);
      return evaluateTriggers(event, this.config);
    } catch (error) {
      if (error instanceof GitHubValidationError) {
        return { type: 'no_action', reason: error.message };
      }
      throw error;
    }
  }
}

/**
 * Create a webhook handler instance
 */
export function createWebhookHandler(config: WebhookHandlerConfig): WebhookHandler {
  return new WebhookHandler(config);
}

// Re-export types and utilities for convenience
export { parseWebhookEvent, isSupportedEvent } from './parser.js';
export { evaluateTriggers, requiresProcessing, getActionIssueNumber } from './triggers.js';
export type { TriggerConfig } from './triggers.js';
