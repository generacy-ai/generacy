import type {
  JiraWebhookEvent,
  JiraEventType,
  WebhookAction,
  WebhookActionType,
  WebhookHandler,
  WebhookHandlerRegistration,
} from './types.js';
import { parseWebhookPayload, parseWebhookAction } from './parser.js';

/**
 * Configuration for webhook handler
 */
export interface JiraWebhookHandlerConfig {
  /** Optional webhook secret for verification */
  webhookSecret?: string;
  /** Whether to log events */
  logEvents?: boolean;
}

/**
 * Result of processing a webhook event
 */
export interface WebhookProcessResult {
  success: boolean;
  action: WebhookAction;
  handlersExecuted: number;
  errors: Error[];
}

/**
 * Jira webhook event handler
 */
export class JiraWebhookHandler {
  private handlers: WebhookHandlerRegistration[] = [];
  private readonly config: JiraWebhookHandlerConfig;

  constructor(config: JiraWebhookHandlerConfig = {}) {
    this.config = config;
  }

  /**
   * Register a handler for specific event types
   */
  on(
    eventTypes: JiraEventType | JiraEventType[],
    handler: WebhookHandler
  ): this {
    const types = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
    this.handlers.push({ eventTypes: types, handler });
    return this;
  }

  /**
   * Register a handler for specific action types
   */
  onAction(
    actionTypes: WebhookActionType | WebhookActionType[],
    handler: WebhookHandler
  ): this {
    const types = Array.isArray(actionTypes) ? actionTypes : [actionTypes];
    this.handlers.push({
      eventTypes: [], // Will match any event type
      actionTypes: types,
      handler,
    });
    return this;
  }

  /**
   * Register a handler for issue created events
   */
  onIssueCreated(handler: WebhookHandler): this {
    return this.on('jira:issue_created', handler);
  }

  /**
   * Register a handler for issue updated events
   */
  onIssueUpdated(handler: WebhookHandler): this {
    return this.on('jira:issue_updated', handler);
  }

  /**
   * Register a handler for issue transitioned events
   */
  onIssueTransitioned(handler: WebhookHandler): this {
    return this.onAction('issue_transitioned', handler);
  }

  /**
   * Register a handler for issue assigned events
   */
  onIssueAssigned(handler: WebhookHandler): this {
    return this.onAction('issue_assigned', handler);
  }

  /**
   * Register a handler for comment created events
   */
  onCommentCreated(handler: WebhookHandler): this {
    return this.on('comment_created', handler);
  }

  /**
   * Process a raw webhook payload
   */
  async handle(payload: unknown): Promise<WebhookProcessResult> {
    const event = parseWebhookPayload(payload);
    return this.processEvent(event);
  }

  /**
   * Process a typed webhook event
   */
  async processEvent(event: JiraWebhookEvent): Promise<WebhookProcessResult> {
    const action = parseWebhookAction(event);

    if (this.config.logEvents) {
      console.log(`[JiraWebhook] ${event.webhookEvent} -> ${action.type}`, {
        issueKey: action.issueKey,
        userId: action.userId,
      });
    }

    const matchingHandlers = this.findMatchingHandlers(event, action);
    const errors: Error[] = [];

    for (const registration of matchingHandlers) {
      try {
        await registration.handler(event, action);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    return {
      success: errors.length === 0,
      action,
      handlersExecuted: matchingHandlers.length,
      errors,
    };
  }

  /**
   * Find handlers that match the event and action
   */
  private findMatchingHandlers(
    event: JiraWebhookEvent,
    action: WebhookAction
  ): WebhookHandlerRegistration[] {
    return this.handlers.filter((registration) => {
      // Check event type match
      const eventTypeMatch =
        registration.eventTypes.length === 0 ||
        registration.eventTypes.includes(event.webhookEvent);

      // Check action type match
      const actionTypeMatch =
        !registration.actionTypes ||
        registration.actionTypes.length === 0 ||
        registration.actionTypes.includes(action.type);

      return eventTypeMatch && actionTypeMatch;
    });
  }

  /**
   * Clear all registered handlers
   */
  clearHandlers(): void {
    this.handlers = [];
  }

  /**
   * Get the number of registered handlers
   */
  get handlerCount(): number {
    return this.handlers.length;
  }
}

/**
 * Create a new webhook handler instance
 */
export function createWebhookHandler(
  config?: JiraWebhookHandlerConfig
): JiraWebhookHandler {
  return new JiraWebhookHandler(config);
}
