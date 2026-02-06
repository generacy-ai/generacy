import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IssueOperations, createIssueOperations } from '../../src/operations/issues.js';
import { JiraClient } from '../../src/client.js';
import { JiraNotFoundError, JiraValidationError } from '../../src/utils/errors.js';
import issueStoryFixture from '../fixtures/issue-story.json';

// Mock the client
vi.mock('../../src/client.js', () => ({
  JiraClient: vi.fn(),
}));

describe('IssueOperations', () => {
  let mockClient: {
    v3: {
      issues: {
        createIssue: ReturnType<typeof vi.fn>;
        getIssue: ReturnType<typeof vi.fn>;
        editIssue: ReturnType<typeof vi.fn>;
        deleteIssue: ReturnType<typeof vi.fn>;
        assignIssue: ReturnType<typeof vi.fn>;
      };
    };
  };
  let operations: IssueOperations;

  beforeEach(() => {
    mockClient = {
      v3: {
        issues: {
          createIssue: vi.fn(),
          getIssue: vi.fn(),
          editIssue: vi.fn(),
          deleteIssue: vi.fn(),
          assignIssue: vi.fn(),
        },
      },
    };
    operations = createIssueOperations(mockClient as unknown as JiraClient);
  });

  describe('get', () => {
    it('should get an issue by key', async () => {
      mockClient.v3.issues.getIssue.mockResolvedValue(issueStoryFixture);

      const issue = await operations.get('PROJ-123');

      expect(mockClient.v3.issues.getIssue).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        expand: 'names,transitions',
      });
      expect(issue.key).toBe('PROJ-123');
      expect(issue.summary).toBe('Implement user authentication');
    });

    it('should get an issue by ID', async () => {
      mockClient.v3.issues.getIssue.mockResolvedValue(issueStoryFixture);

      const issue = await operations.get('10001');

      expect(mockClient.v3.issues.getIssue).toHaveBeenCalledWith({
        issueIdOrKey: '10001',
        expand: 'names,transitions',
      });
      expect(issue.id).toBe('10001');
    });

    it('should throw JiraNotFoundError for non-existent issue', async () => {
      mockClient.v3.issues.getIssue.mockRejectedValue({ status: 404 });

      await expect(operations.get('PROJ-999')).rejects.toThrow(JiraNotFoundError);
    });

    it('should throw JiraValidationError for invalid issue key', async () => {
      await expect(operations.get('invalid')).rejects.toThrow(JiraValidationError);
    });
  });

  describe('create', () => {
    it('should create an issue with required fields', async () => {
      mockClient.v3.issues.createIssue.mockResolvedValue({ key: 'PROJ-124', id: '10002' });
      mockClient.v3.issues.getIssue.mockResolvedValue({
        ...issueStoryFixture,
        key: 'PROJ-124',
        id: '10002',
      });

      const issue = await operations.create({
        projectKey: 'PROJ',
        summary: 'New issue',
        issueType: 'Story',
      });

      expect(mockClient.v3.issues.createIssue).toHaveBeenCalledWith({
        fields: {
          project: { key: 'PROJ' },
          summary: 'New issue',
          issuetype: { name: 'Story' },
        },
      });
      expect(issue.key).toBe('PROJ-124');
    });

    it('should create an issue with all optional fields', async () => {
      mockClient.v3.issues.createIssue.mockResolvedValue({ key: 'PROJ-125', id: '10003' });
      mockClient.v3.issues.getIssue.mockResolvedValue({
        ...issueStoryFixture,
        key: 'PROJ-125',
        id: '10003',
      });

      await operations.create({
        projectKey: 'PROJ',
        summary: 'Full issue',
        issueType: 'Story',
        description: 'A description',
        priority: 'High',
        assignee: 'user-account-id',
        labels: ['backend', 'api'],
        components: ['API'],
        dueDate: '2024-03-01',
        parentKey: 'PROJ-100',
        customFields: { customfield_10001: 'value' },
      });

      expect(mockClient.v3.issues.createIssue).toHaveBeenCalledWith({
        fields: expect.objectContaining({
          project: { key: 'PROJ' },
          summary: 'Full issue',
          issuetype: { name: 'Story' },
          priority: { name: 'High' },
          assignee: { accountId: 'user-account-id' },
          labels: ['backend', 'api'],
          components: [{ name: 'API' }],
          duedate: '2024-03-01',
          parent: { key: 'PROJ-100' },
          customfield_10001: 'value',
        }),
      });
    });

    it('should throw JiraValidationError for invalid project key', async () => {
      await expect(
        operations.create({
          projectKey: 'lowercase',
          summary: 'Test',
          issueType: 'Story',
        })
      ).rejects.toThrow(JiraValidationError);
    });
  });

  describe('update', () => {
    it('should update an issue', async () => {
      mockClient.v3.issues.editIssue.mockResolvedValue(undefined);
      mockClient.v3.issues.getIssue.mockResolvedValue({
        ...issueStoryFixture,
        fields: {
          ...issueStoryFixture.fields,
          summary: 'Updated summary',
        },
      });

      const issue = await operations.update('PROJ-123', {
        summary: 'Updated summary',
      });

      expect(mockClient.v3.issues.editIssue).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        fields: {
          summary: 'Updated summary',
        },
      });
      expect(issue.summary).toBe('Updated summary');
    });

    it('should clear optional fields when set to null', async () => {
      mockClient.v3.issues.editIssue.mockResolvedValue(undefined);
      mockClient.v3.issues.getIssue.mockResolvedValue(issueStoryFixture);

      await operations.update('PROJ-123', {
        assignee: null,
        dueDate: null,
      });

      expect(mockClient.v3.issues.editIssue).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        fields: {
          assignee: null,
          duedate: null,
        },
      });
    });
  });

  describe('delete', () => {
    it('should delete an issue', async () => {
      mockClient.v3.issues.deleteIssue.mockResolvedValue(undefined);

      await operations.delete('PROJ-123');

      expect(mockClient.v3.issues.deleteIssue).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        deleteSubtasks: false,
      });
    });

    it('should delete an issue with subtasks', async () => {
      mockClient.v3.issues.deleteIssue.mockResolvedValue(undefined);

      await operations.delete('PROJ-123', true);

      expect(mockClient.v3.issues.deleteIssue).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        deleteSubtasks: true,
      });
    });
  });

  describe('assign', () => {
    it('should assign an issue to a user', async () => {
      mockClient.v3.issues.assignIssue.mockResolvedValue(undefined);

      await operations.assign('PROJ-123', 'user-account-id');

      expect(mockClient.v3.issues.assignIssue).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        accountId: 'user-account-id',
      });
    });

    it('should unassign an issue', async () => {
      mockClient.v3.issues.assignIssue.mockResolvedValue(undefined);

      await operations.assign('PROJ-123', null);

      expect(mockClient.v3.issues.assignIssue).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        accountId: '-1',
      });
    });
  });
});
