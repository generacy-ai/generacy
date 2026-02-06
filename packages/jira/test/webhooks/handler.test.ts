import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  JiraWebhookHandler,
  createWebhookHandler,
} from '../../src/webhooks/handler.js';
import {
  parseWebhookPayload,
  parseWebhookAction,
  hasFieldChange,
  getFieldChange,
  getIssueKeyFromEvent,
} from '../../src/webhooks/parser.js';
import type { JiraIssueEvent, JiraCommentEvent } from '../../src/webhooks/types.js';
import webhookFixture from '../fixtures/webhook-issue-updated.json';

describe('Webhook Parser', () => {
  describe('parseWebhookPayload', () => {
    it('should parse a valid webhook payload', () => {
      const event = parseWebhookPayload(webhookFixture);

      expect(event.webhookEvent).toBe('jira:issue_updated');
      expect(event.timestamp).toBe(1705764300000);
      expect(event.user.displayName).toBe('Jane Smith');
    });

    it('should throw for invalid payload', () => {
      expect(() => parseWebhookPayload(null)).toThrow();
      expect(() => parseWebhookPayload({})).toThrow();
      expect(() => parseWebhookPayload('string')).toThrow();
    });
  });

  describe('parseWebhookAction', () => {
    it('should detect issue_transitioned action', () => {
      const event = parseWebhookPayload(webhookFixture) as JiraIssueEvent;
      const action = parseWebhookAction(event);

      expect(action.type).toBe('issue_transitioned');
      expect(action.issueKey).toBe('PROJ-123');
      expect(action.previousStatus).toBe('To Do');
      expect(action.newStatus).toBe('In Progress');
    });

    it('should detect issue_created action', () => {
      const event: JiraIssueEvent = {
        ...webhookFixture,
        webhookEvent: 'jira:issue_created',
        changelog: undefined,
      } as unknown as JiraIssueEvent;

      const action = parseWebhookAction(event);

      expect(action.type).toBe('issue_created');
    });

    it('should detect issue_assigned action', () => {
      const event: JiraIssueEvent = {
        ...webhookFixture,
        webhookEvent: 'jira:issue_updated',
        changelog: {
          id: '10001',
          items: [
            {
              field: 'assignee',
              fieldtype: 'jira',
              fieldId: 'assignee',
              from: null,
              fromString: null,
              to: 'user-123',
              toString: 'New User',
            },
          ],
        },
      } as unknown as JiraIssueEvent;

      const action = parseWebhookAction(event);

      expect(action.type).toBe('issue_assigned');
      expect(action.newAssignee).toBe('New User');
    });

    it('should detect comment_added action', () => {
      const event: JiraCommentEvent = {
        webhookEvent: 'comment_created',
        timestamp: Date.now(),
        user: webhookFixture.user,
        issue: webhookFixture.issue,
        comment: {
          id: '10001',
          body: { version: 1, type: 'doc', content: [] },
        },
      } as unknown as JiraCommentEvent;

      const action = parseWebhookAction(event);

      expect(action.type).toBe('comment_added');
    });
  });

  describe('hasFieldChange', () => {
    it('should detect field changes', () => {
      const event = parseWebhookPayload(webhookFixture) as JiraIssueEvent;

      expect(hasFieldChange(event.changelog, 'status')).toBe(true);
      expect(hasFieldChange(event.changelog, 'assignee')).toBe(true);
      expect(hasFieldChange(event.changelog, 'priority')).toBe(false);
    });

    it('should be case-insensitive', () => {
      const event = parseWebhookPayload(webhookFixture) as JiraIssueEvent;

      expect(hasFieldChange(event.changelog, 'Status')).toBe(true);
      expect(hasFieldChange(event.changelog, 'STATUS')).toBe(true);
    });
  });

  describe('getFieldChange', () => {
    it('should return field change details', () => {
      const event = parseWebhookPayload(webhookFixture) as JiraIssueEvent;
      const change = getFieldChange(event.changelog, 'status');

      expect(change).toBeDefined();
      expect(change?.fromString).toBe('To Do');
      expect(change?.toString).toBe('In Progress');
    });

    it('should return undefined for non-existent field', () => {
      const event = parseWebhookPayload(webhookFixture) as JiraIssueEvent;
      const change = getFieldChange(event.changelog, 'nonexistent');

      expect(change).toBeUndefined();
    });
  });

  describe('getIssueKeyFromEvent', () => {
    it('should extract issue key from issue events', () => {
      const event = parseWebhookPayload(webhookFixture);
      const key = getIssueKeyFromEvent(event);

      expect(key).toBe('PROJ-123');
    });
  });
});

describe('JiraWebhookHandler', () => {
  let handler: JiraWebhookHandler;

  beforeEach(() => {
    handler = createWebhookHandler();
  });

  describe('on', () => {
    it('should register and execute handler for event type', async () => {
      const mockHandler = vi.fn();
      handler.on('jira:issue_updated', mockHandler);

      await handler.handle(webhookFixture);

      expect(mockHandler).toHaveBeenCalledTimes(1);
      expect(mockHandler).toHaveBeenCalledWith(
        expect.objectContaining({ webhookEvent: 'jira:issue_updated' }),
        expect.objectContaining({ type: 'issue_transitioned' })
      );
    });

    it('should not execute handler for non-matching event type', async () => {
      const mockHandler = vi.fn();
      handler.on('jira:issue_created', mockHandler);

      await handler.handle(webhookFixture);

      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('should support multiple event types', async () => {
      const mockHandler = vi.fn();
      handler.on(['jira:issue_created', 'jira:issue_updated'], mockHandler);

      await handler.handle(webhookFixture);

      expect(mockHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('onAction', () => {
    it('should register and execute handler for action type', async () => {
      const mockHandler = vi.fn();
      handler.onAction('issue_transitioned', mockHandler);

      await handler.handle(webhookFixture);

      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it('should not execute handler for non-matching action type', async () => {
      const mockHandler = vi.fn();
      handler.onAction('issue_created', mockHandler);

      await handler.handle(webhookFixture);

      expect(mockHandler).not.toHaveBeenCalled();
    });
  });

  describe('convenience methods', () => {
    it('onIssueCreated should register handler', async () => {
      const mockHandler = vi.fn();
      handler.onIssueCreated(mockHandler);

      expect(handler.handlerCount).toBe(1);
    });

    it('onIssueTransitioned should match transitioned events', async () => {
      const mockHandler = vi.fn();
      handler.onIssueTransitioned(mockHandler);

      await handler.handle(webhookFixture);

      expect(mockHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('processEvent', () => {
    it('should return process result with success', async () => {
      const mockHandler = vi.fn();
      handler.on('jira:issue_updated', mockHandler);

      const result = await handler.handle(webhookFixture);

      expect(result.success).toBe(true);
      expect(result.handlersExecuted).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(result.action.type).toBe('issue_transitioned');
    });

    it('should capture handler errors', async () => {
      const mockHandler = vi.fn().mockRejectedValue(new Error('Handler failed'));
      handler.on('jira:issue_updated', mockHandler);

      const result = await handler.handle(webhookFixture);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toBe('Handler failed');
    });

    it('should execute multiple matching handlers', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      handler.on('jira:issue_updated', handler1);
      handler.onAction('issue_transitioned', handler2);

      const result = await handler.handle(webhookFixture);

      expect(result.handlersExecuted).toBe(2);
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  describe('clearHandlers', () => {
    it('should remove all handlers', async () => {
      const mockHandler = vi.fn();
      handler.on('jira:issue_updated', mockHandler);
      handler.clearHandlers();

      await handler.handle(webhookFixture);

      expect(mockHandler).not.toHaveBeenCalled();
      expect(handler.handlerCount).toBe(0);
    });
  });
});
