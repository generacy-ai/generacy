import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchOperations, createSearchOperations } from '../../src/operations/search.js';
import { JiraClient } from '../../src/client.js';
import searchResultsFixture from '../fixtures/search-results.json';

// Mock the client
vi.mock('../../src/client.js', () => ({
  JiraClient: vi.fn(),
}));

describe('SearchOperations', () => {
  let mockClient: {
    v3: {
      issueSearch: {
        searchForIssuesUsingJql: ReturnType<typeof vi.fn>;
      };
    };
  };
  let operations: SearchOperations;

  beforeEach(() => {
    mockClient = {
      v3: {
        issueSearch: {
          searchForIssuesUsingJql: vi.fn(),
        },
      },
    };
    operations = createSearchOperations(mockClient as unknown as JiraClient);
  });

  describe('search', () => {
    it('should search issues using JQL', async () => {
      mockClient.v3.issueSearch.searchForIssuesUsingJql.mockResolvedValue(searchResultsFixture);

      const results: unknown[] = [];
      for await (const issue of operations.search('project = PROJ')) {
        results.push(issue);
      }

      expect(mockClient.v3.issueSearch.searchForIssuesUsingJql).toHaveBeenCalledWith({
        jql: 'project = PROJ',
        startAt: 0,
        maxResults: 50,
        fields: ['*all'],
        expand: undefined,
        validateQuery: 'strict',
      });
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ key: 'PROJ-123' });
      expect(results[1]).toMatchObject({ key: 'PROJ-124' });
    });

    it('should paginate through results', async () => {
      const page1 = {
        ...searchResultsFixture,
        total: 4,
        issues: [searchResultsFixture.issues[0]],
      };
      const page2 = {
        ...searchResultsFixture,
        startAt: 1,
        total: 4,
        issues: [searchResultsFixture.issues[1]],
      };
      const page3 = {
        ...searchResultsFixture,
        startAt: 2,
        total: 4,
        issues: [],
      };

      mockClient.v3.issueSearch.searchForIssuesUsingJql
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce(page2)
        .mockResolvedValueOnce(page3);

      const results: unknown[] = [];
      for await (const issue of operations.search('project = PROJ', { pageSize: 1 })) {
        results.push(issue);
      }

      // Expected: 3 calls - page1 (1 issue), page2 (1 issue), page3 (0 issues - triggers stop)
      expect(mockClient.v3.issueSearch.searchForIssuesUsingJql).toHaveBeenCalledTimes(3);
      expect(results).toHaveLength(2);
    });

    it('should apply search options', async () => {
      mockClient.v3.issueSearch.searchForIssuesUsingJql.mockResolvedValue({
        ...searchResultsFixture,
        issues: [],
        total: 0,
      });

      const results: unknown[] = [];
      for await (const issue of operations.search('project = PROJ', {
        fields: ['summary', 'status'],
        expand: ['changelog'],
        pageSize: 25,
        validateQuery: false,
      })) {
        results.push(issue);
      }

      expect(mockClient.v3.issueSearch.searchForIssuesUsingJql).toHaveBeenCalledWith({
        jql: 'project = PROJ',
        startAt: 0,
        maxResults: 25,
        fields: ['summary', 'status'],
        expand: 'changelog',
        validateQuery: 'none',
      });
    });
  });

  describe('searchAll', () => {
    it('should return all results as an array', async () => {
      mockClient.v3.issueSearch.searchForIssuesUsingJql.mockResolvedValue(searchResultsFixture);

      const results = await operations.searchAll('project = PROJ');

      expect(results).toHaveLength(2);
      expect(results[0]?.key).toBe('PROJ-123');
    });
  });

  describe('count', () => {
    it('should return the count of matching issues', async () => {
      mockClient.v3.issueSearch.searchForIssuesUsingJql.mockResolvedValue({
        total: 42,
        issues: [],
      });

      const count = await operations.count('project = PROJ');

      expect(mockClient.v3.issueSearch.searchForIssuesUsingJql).toHaveBeenCalledWith({
        jql: 'project = PROJ',
        startAt: 0,
        maxResults: 0,
        fields: ['key'],
      });
      expect(count).toBe(42);
    });
  });

  describe('convenience methods', () => {
    it('should search by project', async () => {
      mockClient.v3.issueSearch.searchForIssuesUsingJql.mockResolvedValue({
        ...searchResultsFixture,
        issues: [],
        total: 0,
      });

      const generator = await operations.byProject('TEST');
      for await (const _issue of generator) {
        // consume generator
      }

      expect(mockClient.v3.issueSearch.searchForIssuesUsingJql).toHaveBeenCalledWith(
        expect.objectContaining({
          jql: 'project = "TEST"',
        })
      );
    });

    it('should search by assignee', async () => {
      mockClient.v3.issueSearch.searchForIssuesUsingJql.mockResolvedValue({
        ...searchResultsFixture,
        issues: [],
        total: 0,
      });

      const generator = await operations.byAssignee('user-123');
      for await (const _issue of generator) {
        // consume generator
      }

      expect(mockClient.v3.issueSearch.searchForIssuesUsingJql).toHaveBeenCalledWith(
        expect.objectContaining({
          jql: 'assignee = "user-123"',
        })
      );
    });

    it('should search by status', async () => {
      mockClient.v3.issueSearch.searchForIssuesUsingJql.mockResolvedValue({
        ...searchResultsFixture,
        issues: [],
        total: 0,
      });

      const generator = await operations.byStatus('In Progress', 'PROJ');
      for await (const _issue of generator) {
        // consume generator
      }

      expect(mockClient.v3.issueSearch.searchForIssuesUsingJql).toHaveBeenCalledWith(
        expect.objectContaining({
          jql: 'status = "In Progress" AND project = "PROJ"',
        })
      );
    });

    it('should search by sprint', async () => {
      mockClient.v3.issueSearch.searchForIssuesUsingJql.mockResolvedValue({
        ...searchResultsFixture,
        issues: [],
        total: 0,
      });

      const generator = await operations.bySprint(123);
      for await (const _issue of generator) {
        // consume generator
      }

      expect(mockClient.v3.issueSearch.searchForIssuesUsingJql).toHaveBeenCalledWith(
        expect.objectContaining({
          jql: 'sprint = 123',
        })
      );
    });
  });
});
