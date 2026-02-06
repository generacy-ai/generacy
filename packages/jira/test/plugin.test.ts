import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JiraPlugin, createPlugin } from '../src/plugin.js';
import { JiraValidationError } from '../src/utils/errors.js';

// Mock jira.js
vi.mock('jira.js', () => ({
  Version3Client: vi.fn().mockImplementation(() => ({
    myself: {
      getCurrentUser: vi.fn().mockResolvedValue({
        accountId: 'test-account-id',
        displayName: 'Test User',
        emailAddress: 'test@example.com',
      }),
    },
    serverInfo: {
      getServerInfo: vi.fn().mockResolvedValue({
        version: '1001.0.0-SNAPSHOT',
        baseUrl: 'https://test.atlassian.net',
      }),
    },
    issues: {
      createIssue: vi.fn().mockResolvedValue({ key: 'TEST-1', id: '10001' }),
      getIssue: vi.fn().mockResolvedValue({
        id: '10001',
        key: 'TEST-1',
        self: 'https://test.atlassian.net/rest/api/3/issue/10001',
        fields: {
          summary: 'Test Issue',
          status: { id: '1', name: 'To Do', statusCategory: { id: 2, key: 'new', name: 'To Do', colorName: 'blue-gray' } },
          issuetype: { id: '1', name: 'Story', description: '', iconUrl: '', subtask: false, hierarchyLevel: 0 },
          priority: { id: '3', name: 'Medium', iconUrl: '' },
          reporter: { accountId: 'user-1', displayName: 'Reporter', emailAddress: null, avatarUrls: {}, active: true },
          assignee: null,
          project: { id: '1', key: 'TEST', name: 'Test Project', self: '' },
          created: '2024-01-01T00:00:00.000Z',
          updated: '2024-01-01T00:00:00.000Z',
          labels: [],
          components: [],
        },
      }),
      editIssue: vi.fn().mockResolvedValue(undefined),
      deleteIssue: vi.fn().mockResolvedValue(undefined),
      assignIssue: vi.fn().mockResolvedValue(undefined),
      getTransitions: vi.fn().mockResolvedValue({
        transitions: [
          { id: '11', name: 'Start', to: { id: '3', name: 'In Progress' } },
        ],
      }),
      doTransition: vi.fn().mockResolvedValue(undefined),
    },
    issueSearch: {
      searchForIssuesUsingJql: vi.fn().mockResolvedValue({
        issues: [],
        total: 0,
      }),
    },
    issueComments: {
      addComment: vi.fn().mockResolvedValue({
        id: '1',
        self: '',
        author: { accountId: 'user-1', displayName: 'User', avatarUrls: {} },
        body: { version: 1, type: 'doc', content: [] },
        created: '2024-01-01T00:00:00.000Z',
        updated: '2024-01-01T00:00:00.000Z',
      }),
      getComments: vi.fn().mockResolvedValue({ comments: [] }),
      updateComment: vi.fn().mockResolvedValue({}),
      deleteComment: vi.fn().mockResolvedValue(undefined),
    },
    issueFields: {
      getFields: vi.fn().mockResolvedValue([]),
    },
  })),
  AgileClient: vi.fn().mockImplementation(() => ({
    board: {
      getAllSprints: vi.fn().mockResolvedValue({ values: [] }),
      getAllBoards: vi.fn().mockResolvedValue({ values: [] }),
    },
    sprint: {
      getSprint: vi.fn().mockResolvedValue({}),
      moveIssuesToSprintAndRank: vi.fn().mockResolvedValue(undefined),
    },
    backlog: {
      moveIssuesToBacklog: vi.fn().mockResolvedValue(undefined),
    },
  })),
}));

describe('JiraPlugin', () => {
  const validConfig = {
    host: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'test-token',
    projectKey: 'TEST',
  };

  describe('constructor', () => {
    it('should create plugin with valid config', () => {
      const plugin = new JiraPlugin(validConfig);
      expect(plugin).toBeInstanceOf(JiraPlugin);
      expect(plugin.host).toBe(validConfig.host);
      expect(plugin.projectKey).toBe(validConfig.projectKey);
    });

    it('should throw for invalid config', () => {
      expect(() => {
        new JiraPlugin({
          ...validConfig,
          email: 'invalid',
        });
      }).toThrow(JiraValidationError);
    });
  });

  describe('createPlugin', () => {
    it('should create a plugin instance', () => {
      const plugin = createPlugin(validConfig);
      expect(plugin).toBeInstanceOf(JiraPlugin);
    });
  });

  describe('issue operations', () => {
    let plugin: JiraPlugin;

    beforeEach(() => {
      plugin = createPlugin(validConfig);
    });

    it('should create an issue', async () => {
      const issue = await plugin.createIssue({
        projectKey: 'TEST',
        summary: 'Test Issue',
        issueType: 'Story',
      });

      expect(issue.key).toBe('TEST-1');
    });

    it('should get an issue', async () => {
      const issue = await plugin.getIssue('TEST-1');

      expect(issue.key).toBe('TEST-1');
      expect(issue.summary).toBe('Test Issue');
    });

    it('should update an issue', async () => {
      const issue = await plugin.updateIssue('TEST-1', {
        summary: 'Updated Summary',
      });

      expect(issue).toBeDefined();
    });

    it('should delete an issue', async () => {
      await expect(plugin.deleteIssue('TEST-1')).resolves.toBeUndefined();
    });

    it('should assign an issue', async () => {
      await expect(plugin.assignIssue('TEST-1', 'user-123')).resolves.toBeUndefined();
    });
  });

  describe('search operations', () => {
    let plugin: JiraPlugin;

    beforeEach(() => {
      plugin = createPlugin(validConfig);
    });

    it('should search issues', async () => {
      const results = await plugin.searchIssuesAll('project = TEST');
      expect(results).toEqual([]);
    });

    it('should count issues', async () => {
      const count = await plugin.countIssues('project = TEST');
      expect(count).toBe(0);
    });
  });

  describe('comment operations', () => {
    let plugin: JiraPlugin;

    beforeEach(() => {
      plugin = createPlugin(validConfig);
    });

    it('should add a comment', async () => {
      const comment = await plugin.addComment('TEST-1', 'Test comment');
      expect(comment.id).toBe('1');
    });

    it('should get comments', async () => {
      const comments = await plugin.getComments('TEST-1');
      expect(comments).toEqual([]);
    });
  });

  describe('transition operations', () => {
    let plugin: JiraPlugin;

    beforeEach(() => {
      plugin = createPlugin(validConfig);
    });

    it('should get transitions', async () => {
      const transitions = await plugin.getTransitions('TEST-1');
      expect(transitions).toHaveLength(1);
      expect(transitions[0]?.name).toBe('Start');
    });

    it('should transition an issue', async () => {
      await expect(plugin.transitionIssue('TEST-1', '11')).resolves.toBeUndefined();
    });
  });

  describe('utility methods', () => {
    let plugin: JiraPlugin;

    beforeEach(() => {
      plugin = createPlugin(validConfig);
    });

    it('should verify auth', async () => {
      const user = await plugin.verifyAuth();
      expect(user.displayName).toBe('Test User');
    });

    it('should check connection', async () => {
      const info = await plugin.checkConnection();
      expect(info.baseUrl).toBe('https://test.atlassian.net');
    });

    it('should expose operations', () => {
      expect(plugin.operations.issues).toBeDefined();
      expect(plugin.operations.search).toBeDefined();
      expect(plugin.operations.comments).toBeDefined();
      expect(plugin.operations.transitions).toBeDefined();
      expect(plugin.operations.customFields).toBeDefined();
      expect(plugin.operations.sprints).toBeDefined();
    });

    it('should expose webhook handler', () => {
      expect(plugin.webhook).toBeDefined();
    });
  });

  describe('webhook operations', () => {
    let plugin: JiraPlugin;

    beforeEach(() => {
      plugin = createPlugin(validConfig);
    });

    it('should handle raw webhook payload', async () => {
      const payload = {
        webhookEvent: 'jira:issue_created',
        timestamp: Date.now(),
        user: { accountId: 'user-1', displayName: 'User' },
        issue: { id: '1', key: 'TEST-1', fields: {} },
      };

      const action = await plugin.handleRawWebhook(payload);
      expect(action.type).toBe('issue_created');
    });
  });
});
