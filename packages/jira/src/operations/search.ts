import type { JiraClient } from '../client.js';
import type {
  JiraIssue,
  SearchOptions,
  JiraUser,
  IssueType,
  Priority,
  IssueRef,
  Component,
  IssueLink,
} from '../types/issues.js';
import type { JiraStatus } from '../types/workflows.js';
import type { ProjectRef } from '../types/projects.js';
import type { Sprint } from '../types/sprints.js';
import type { AdfDocument } from '../types/events.js';
import { wrapJiraError } from '../utils/errors.js';

/**
 * Map Jira API response to JiraIssue (simplified for search results)
 */
function mapSearchIssue(raw: Record<string, unknown>): JiraIssue {
  const fields = raw.fields as Record<string, unknown>;

  return {
    id: raw.id as string,
    key: raw.key as string,
    self: raw.self as string,
    summary: (fields.summary as string) ?? '',
    description: (fields.description as AdfDocument) ?? null,
    status: (fields.status as JiraStatus) ?? { id: '', name: '', description: null, statusCategory: { id: 0, key: 'new', name: '', colorName: '' } },
    issueType: (fields.issuetype as IssueType) ?? { id: '', name: '', description: '', iconUrl: '', subtask: false, hierarchyLevel: 0 },
    priority: (fields.priority as Priority) ?? { id: '', name: '', iconUrl: '' },
    reporter: (fields.reporter as JiraUser) ?? { accountId: '', displayName: '', emailAddress: null, avatarUrls: { '16x16': '', '24x24': '', '32x32': '', '48x48': '' }, active: true },
    assignee: (fields.assignee as JiraUser) ?? null,
    project: (fields.project as ProjectRef) ?? { id: '', key: '', name: '', self: '' },
    parent: (fields.parent as IssueRef) ?? null,
    subtasks: (fields.subtasks as IssueRef[]) ?? [],
    linkedIssues: (fields.issuelinks as IssueLink[]) ?? [],
    created: (fields.created as string) ?? '',
    updated: (fields.updated as string) ?? '',
    dueDate: (fields.duedate as string) ?? null,
    sprint: extractSprint(fields),
    labels: (fields.labels as string[]) ?? [],
    components: (fields.components as Component[]) ?? [],
    customFields: extractCustomFields(fields),
  };
}

/**
 * Extract sprint from issue fields
 */
function extractSprint(fields: Record<string, unknown>): Sprint | null {
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith('customfield_') && Array.isArray(value) && value.length > 0) {
      const first = value[0];
      if (first && typeof first === 'object' && 'state' in first && 'name' in first) {
        return first as Sprint;
      }
    }
  }
  return null;
}

/**
 * Extract custom fields from issue fields
 */
function extractCustomFields(fields: Record<string, unknown>): Record<string, unknown> {
  const customFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith('customfield_')) {
      customFields[key] = value;
    }
  }
  return customFields;
}

/**
 * Search operations for JQL queries
 */
export class SearchOperations {
  constructor(private readonly client: JiraClient) {}

  /**
   * Search issues using JQL with async iterator for memory-efficient pagination
   */
  async *search(jql: string, options?: SearchOptions): AsyncGenerator<JiraIssue> {
    const pageSize = options?.pageSize ?? 50;
    const fields = options?.fields ?? ['*all'];
    const expand = options?.expand ?? [];
    const validateQuery = options?.validateQuery ?? true;

    let startAt = options?.startAt ?? 0;

    try {
      while (true) {
        const response = await this.client.v3.issueSearch.searchForIssuesUsingJql({
          jql,
          startAt,
          maxResults: pageSize,
          fields,
          expand: expand.join(',') || undefined,
          validateQuery: validateQuery ? 'strict' : 'none',
        });

        const issues = response.issues ?? [];

        for (const issue of issues) {
          yield mapSearchIssue(issue as unknown as Record<string, unknown>);
        }

        // Check if we've fetched all items
        const total = response.total ?? 0;
        startAt += issues.length;

        if (issues.length < pageSize || startAt >= total) {
          break;
        }
      }
    } catch (error) {
      throw wrapJiraError(error, `JQL search failed: ${jql}`);
    }
  }

  /**
   * Search and return all results as an array
   * Note: Use search() generator for large result sets to avoid memory issues
   */
  async searchAll(jql: string, options?: SearchOptions): Promise<JiraIssue[]> {
    const results: JiraIssue[] = [];
    for await (const issue of this.search(jql, options)) {
      results.push(issue);
    }
    return results;
  }

  /**
   * Count issues matching a JQL query
   */
  async count(jql: string): Promise<number> {
    try {
      const response = await this.client.v3.issueSearch.searchForIssuesUsingJql({
        jql,
        startAt: 0,
        maxResults: 0,
        fields: ['key'],
      });
      return response.total ?? 0;
    } catch (error) {
      throw wrapJiraError(error, `JQL count failed: ${jql}`);
    }
  }

  /**
   * Search issues by project
   */
  byProject(projectKey: string, options?: SearchOptions): AsyncGenerator<JiraIssue> {
    return this.search(`project = "${projectKey}"`, options);
  }

  /**
   * Search issues by assignee
   */
  byAssignee(accountId: string, options?: SearchOptions): AsyncGenerator<JiraIssue> {
    return this.search(`assignee = "${accountId}"`, options);
  }

  /**
   * Search issues by status
   */
  byStatus(statusName: string, projectKey?: string, options?: SearchOptions): AsyncGenerator<JiraIssue> {
    let jql = `status = "${statusName}"`;
    if (projectKey) {
      jql += ` AND project = "${projectKey}"`;
    }
    return this.search(jql, options);
  }

  /**
   * Search issues by sprint
   */
  bySprint(sprintId: number, options?: SearchOptions): AsyncGenerator<JiraIssue> {
    return this.search(`sprint = ${sprintId}`, options);
  }

  /**
   * Search issues updated since a date
   */
  updatedSince(date: Date, projectKey?: string, options?: SearchOptions): AsyncGenerator<JiraIssue> {
    const dateStr = date.toISOString().split('T')[0];
    let jql = `updated >= "${dateStr}"`;
    if (projectKey) {
      jql += ` AND project = "${projectKey}"`;
    }
    return this.search(jql, options);
  }
}

/**
 * Create search operations instance
 */
export function createSearchOperations(client: JiraClient): SearchOperations {
  return new SearchOperations(client);
}
