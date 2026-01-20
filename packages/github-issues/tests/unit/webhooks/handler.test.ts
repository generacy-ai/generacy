import { describe, it, expect } from 'vitest';
import { WebhookHandler } from '../../../src/webhooks/handler.js';
import type { IssuesEventPayload, IssueCommentEventPayload } from '../../../src/types/index.js';

describe('WebhookHandler', () => {
  describe('handle', () => {
    it('should return no_action for unsupported event types', async () => {
      const handler = new WebhookHandler({});

      const result = await handler.handle('push', {});

      expect(result.type).toBe('no_action');
      expect(result).toHaveProperty('reason');
    });

    it('should process issues.assigned event when assigned to agent', async () => {
      const handler = new WebhookHandler({
        agentAccount: 'test-agent',
      });

      const payload: IssuesEventPayload = {
        action: 'assigned',
        issue: {
          number: 42,
          title: 'Test Issue',
          body: 'Test body',
          state: 'open',
          labels: [],
          assignees: [],
          milestone: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          closedAt: null,
          author: { id: 1, login: 'author', avatarUrl: '', type: 'User' },
          url: '',
          htmlUrl: '',
        },
        sender: { id: 1, login: 'sender', avatarUrl: '', type: 'User' },
        repository: {
          id: 1,
          name: 'test-repo',
          fullName: 'test-owner/test-repo',
          owner: { id: 1, login: 'test-owner', avatarUrl: '', type: 'User' },
          htmlUrl: '',
          private: false,
        },
        assignee: { id: 2, login: 'test-agent', avatarUrl: '', type: 'User' },
      };

      const result = await handler.handle('issues', payload);

      expect(result.type).toBe('queue_for_processing');
      if (result.type === 'queue_for_processing') {
        expect(result.issueNumber).toBe(42);
      }
    });

    it('should process issues.labeled event when trigger label is added', async () => {
      const handler = new WebhookHandler({
        triggerLabels: ['autodev:start'],
      });

      const payload: IssuesEventPayload = {
        action: 'labeled',
        issue: {
          number: 42,
          title: 'Test Issue',
          body: 'Test body',
          state: 'open',
          labels: [],
          assignees: [],
          milestone: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          closedAt: null,
          author: { id: 1, login: 'author', avatarUrl: '', type: 'User' },
          url: '',
          htmlUrl: '',
        },
        sender: { id: 1, login: 'sender', avatarUrl: '', type: 'User' },
        repository: {
          id: 1,
          name: 'test-repo',
          fullName: 'test-owner/test-repo',
          owner: { id: 1, login: 'test-owner', avatarUrl: '', type: 'User' },
          htmlUrl: '',
          private: false,
        },
        label: { id: 1, name: 'autodev:start', color: 'ff0000', description: null },
      };

      const result = await handler.handle('issues', payload);

      expect(result.type).toBe('start_workflow');
      if (result.type === 'start_workflow') {
        expect(result.issueNumber).toBe(42);
      }
    });

    it('should process issue_comment.created event with resume pattern', async () => {
      const handler = new WebhookHandler({});

      const payload: IssueCommentEventPayload = {
        action: 'created',
        issue: {
          number: 42,
          title: 'Test Issue',
          body: 'Test body',
          state: 'open',
          labels: [],
          assignees: [],
          milestone: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          closedAt: null,
          author: { id: 1, login: 'author', avatarUrl: '', type: 'User' },
          url: '',
          htmlUrl: '',
        },
        comment: {
          id: 1,
          body: '@agent continue',
          author: { id: 1, login: 'user', avatarUrl: '', type: 'User' },
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          htmlUrl: '',
        },
        sender: { id: 1, login: 'sender', avatarUrl: '', type: 'User' },
        repository: {
          id: 1,
          name: 'test-repo',
          fullName: 'test-owner/test-repo',
          owner: { id: 1, login: 'test-owner', avatarUrl: '', type: 'User' },
          htmlUrl: '',
          private: false,
        },
      };

      const result = await handler.handle('issue_comment', payload);

      expect(result.type).toBe('resume_workflow');
      if (result.type === 'resume_workflow') {
        expect(result.issueNumber).toBe(42);
        expect(result.triggeredBy).toBe('comment');
      }
    });

    it('should return no_action for comment without resume pattern', async () => {
      const handler = new WebhookHandler({});

      const payload: IssueCommentEventPayload = {
        action: 'created',
        issue: {
          number: 42,
          title: 'Test Issue',
          body: 'Test body',
          state: 'open',
          labels: [],
          assignees: [],
          milestone: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          closedAt: null,
          author: { id: 1, login: 'author', avatarUrl: '', type: 'User' },
          url: '',
          htmlUrl: '',
        },
        comment: {
          id: 1,
          body: 'Just a regular comment',
          author: { id: 1, login: 'user', avatarUrl: '', type: 'User' },
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          htmlUrl: '',
        },
        sender: { id: 1, login: 'sender', avatarUrl: '', type: 'User' },
        repository: {
          id: 1,
          name: 'test-repo',
          fullName: 'test-owner/test-repo',
          owner: { id: 1, login: 'test-owner', avatarUrl: '', type: 'User' },
          htmlUrl: '',
          private: false,
        },
      };

      const result = await handler.handle('issue_comment', payload);

      expect(result.type).toBe('no_action');
    });

    it('should detect autodev:ready label as trigger', async () => {
      const handler = new WebhookHandler({});

      const payload: IssuesEventPayload = {
        action: 'labeled',
        issue: {
          number: 42,
          title: 'Test Issue',
          body: 'Test body',
          state: 'open',
          labels: [],
          assignees: [],
          milestone: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          closedAt: null,
          author: { id: 1, login: 'author', avatarUrl: '', type: 'User' },
          url: '',
          htmlUrl: '',
        },
        sender: { id: 1, login: 'sender', avatarUrl: '', type: 'User' },
        repository: {
          id: 1,
          name: 'test-repo',
          fullName: 'test-owner/test-repo',
          owner: { id: 1, login: 'test-owner', avatarUrl: '', type: 'User' },
          htmlUrl: '',
          private: false,
        },
        label: { id: 1, name: 'autodev:ready', color: '00ff00', description: null },
      };

      const result = await handler.handle('issues', payload);

      expect(result.type).toBe('start_workflow');
    });
  });

  describe('verifySignature', () => {
    it('should not throw when no secret is configured', () => {
      const handler = new WebhookHandler({});

      expect(() => {
        handler.verifySignature('payload', 'sha256=invalid');
      }).not.toThrow();
    });

    it('should throw when signature is missing but secret is configured', () => {
      const handler = new WebhookHandler({
        webhookSecret: 'test-secret',
      });

      expect(() => {
        handler.verifySignature('payload', '');
      }).toThrow('Missing webhook signature');
    });

    it('should throw when signature is invalid', () => {
      const handler = new WebhookHandler({
        webhookSecret: 'test-secret',
      });

      expect(() => {
        handler.verifySignature('payload', 'sha256=invalid');
      }).toThrow('Invalid webhook signature');
    });
  });

  describe('processRaw', () => {
    it('should process raw webhook delivery', async () => {
      const handler = new WebhookHandler({
        agentAccount: 'test-agent',
      });

      const payload = JSON.stringify({
        action: 'assigned',
        issue: {
          number: 42,
          title: 'Test',
          body: null,
          state: 'open',
          labels: [],
          assignees: [],
          milestone: null,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          closed_at: null,
          user: { id: 1, login: 'user', avatar_url: '', type: 'User' },
          url: '',
          html_url: '',
        },
        sender: { id: 1, login: 'user', avatar_url: '', type: 'User' },
        repository: {
          id: 1,
          name: 'test-repo',
          full_name: 'test-owner/test-repo',
          owner: { id: 1, login: 'test-owner', avatar_url: '', type: 'User' },
          html_url: '',
          private: false,
        },
        assignee: { id: 2, login: 'test-agent', avatar_url: '', type: 'User' },
      });

      const result = await handler.processRaw(
        {
          'x-github-event': 'issues',
          'x-github-delivery': 'delivery-123',
        },
        payload
      );

      expect(result.success).toBe(true);
      expect(result.action.type).toBe('queue_for_processing');
      expect(result.event?.name).toBe('issues');
    });

    it('should return error for missing event header', async () => {
      const handler = new WebhookHandler({});

      const result = await handler.processRaw({}, '{}');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing X-GitHub-Event');
    });

    it('should return error for invalid JSON', async () => {
      const handler = new WebhookHandler({});

      const result = await handler.processRaw(
        { 'x-github-event': 'issues' },
        'invalid json'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('parse');
    });
  });
});
