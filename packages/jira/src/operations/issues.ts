import type { JiraClient } from '../client.js';
import type {
  JiraIssue,
  CreateJiraIssueParams,
  UpdateJiraIssueParams,
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
import { ensureIssueKey, ensureProjectKey } from '../utils/validation.js';
import { wrapJiraError, JiraNotFoundError } from '../utils/errors.js';
import { ensureAdf } from '../utils/adf.js';

/**
 * Map Jira API response to JiraIssue
 */
function mapIssue(raw: Record<string, unknown>): JiraIssue {
  const fields = raw.fields as Record<string, unknown>;

  return {
    id: raw.id as string,
    key: raw.key as string,
    self: raw.self as string,
    summary: fields.summary as string,
    description: fields.description as AdfDocument | null,
    status: fields.status as JiraStatus,
    issueType: fields.issuetype as IssueType,
    priority: fields.priority as Priority,
    reporter: fields.reporter as JiraUser,
    assignee: fields.assignee as JiraUser | null,
    project: fields.project as ProjectRef,
    parent: fields.parent as IssueRef | null,
    subtasks: (fields.subtasks as IssueRef[]) ?? [],
    linkedIssues: (fields.issuelinks as IssueLink[]) ?? [],
    created: fields.created as string,
    updated: fields.updated as string,
    dueDate: fields.duedate as string | null,
    sprint: extractSprint(fields),
    labels: (fields.labels as string[]) ?? [],
    components: (fields.components as Component[]) ?? [],
    customFields: extractCustomFields(fields),
  };
}

/**
 * Extract sprint from issue fields (usually in a custom field)
 */
function extractSprint(fields: Record<string, unknown>): Sprint | null {
  // Sprint is typically in customfield_10020 or similar
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
 * Issue CRUD operations
 */
export class IssueOperations {
  constructor(private readonly client: JiraClient) {}

  /**
   * Create a new issue
   */
  async create(params: CreateJiraIssueParams): Promise<JiraIssue> {
    const projectKey = ensureProjectKey(params.projectKey);

    const fields: Record<string, unknown> = {
      project: { key: projectKey },
      summary: params.summary,
      issuetype: { name: params.issueType },
    };

    if (params.description) {
      fields.description = ensureAdf(params.description);
    }

    if (params.priority) {
      fields.priority = { name: params.priority };
    }

    if (params.assignee) {
      fields.assignee = { accountId: params.assignee };
    }

    if (params.labels) {
      fields.labels = params.labels;
    }

    if (params.components) {
      fields.components = params.components.map((name) => ({ name }));
    }

    if (params.dueDate) {
      fields.duedate = params.dueDate;
    }

    if (params.parentKey) {
      fields.parent = { key: params.parentKey };
    }

    if (params.customFields) {
      Object.assign(fields, params.customFields);
    }

    try {
      const response = await this.client.v3.issues.createIssue({
        fields: fields as Parameters<typeof this.client.v3.issues.createIssue>[0]['fields'],
      });
      // Fetch the full issue to return complete data
      const createdIssue = response as { key?: string; id?: string };
      return this.get(createdIssue.key ?? createdIssue.id ?? '');
    } catch (error) {
      throw wrapJiraError(error, 'Failed to create issue');
    }
  }

  /**
   * Get an issue by key or ID
   */
  async get(keyOrId: string): Promise<JiraIssue> {
    // If it looks like a key (contains letters), validate as key; otherwise assume numeric ID
    const isKey = /[A-Za-z]/.test(keyOrId);
    const issueIdOrKey = isKey ? ensureIssueKey(keyOrId) : keyOrId;

    try {
      const response = await this.client.v3.issues.getIssue({
        issueIdOrKey,
        expand: 'names,transitions',
      });
      return mapIssue(response as unknown as Record<string, unknown>);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'status' in error && (error as { status: number }).status === 404) {
        throw new JiraNotFoundError('Issue', keyOrId, error);
      }
      throw wrapJiraError(error, `Failed to get issue ${keyOrId}`);
    }
  }

  /**
   * Update an issue
   */
  async update(keyOrId: string, params: UpdateJiraIssueParams): Promise<JiraIssue> {
    // If it looks like a key (contains letters), validate as key; otherwise assume numeric ID
    const isKey = /[A-Za-z]/.test(keyOrId);
    const issueIdOrKey = isKey ? ensureIssueKey(keyOrId) : keyOrId;

    const fields: Record<string, unknown> = {};

    if (params.summary !== undefined) {
      fields.summary = params.summary;
    }

    if (params.description !== undefined) {
      fields.description = params.description ? ensureAdf(params.description) : null;
    }

    if (params.priority !== undefined) {
      fields.priority = params.priority ? { name: params.priority } : null;
    }

    if (params.assignee !== undefined) {
      fields.assignee = params.assignee ? { accountId: params.assignee } : null;
    }

    if (params.labels !== undefined) {
      fields.labels = params.labels;
    }

    if (params.components !== undefined) {
      fields.components = params.components.map((name) => ({ name }));
    }

    if (params.dueDate !== undefined) {
      fields.duedate = params.dueDate;
    }

    if (params.customFields) {
      Object.assign(fields, params.customFields);
    }

    try {
      await this.client.v3.issues.editIssue({
        issueIdOrKey,
        fields,
      });
      return this.get(keyOrId);
    } catch (error) {
      throw wrapJiraError(error, `Failed to update issue ${keyOrId}`);
    }
  }

  /**
   * Delete an issue
   */
  async delete(keyOrId: string, deleteSubtasks = false): Promise<void> {
    const issueIdOrKey = keyOrId.includes('-') ? ensureIssueKey(keyOrId) : keyOrId;

    try {
      await this.client.v3.issues.deleteIssue({
        issueIdOrKey,
        deleteSubtasks,
      });
    } catch (error) {
      throw wrapJiraError(error, `Failed to delete issue ${keyOrId}`);
    }
  }

  /**
   * Assign an issue to a user
   */
  async assign(keyOrId: string, accountId: string | null): Promise<void> {
    const issueIdOrKey = keyOrId.includes('-') ? ensureIssueKey(keyOrId) : keyOrId;

    try {
      await this.client.v3.issues.assignIssue({
        issueIdOrKey,
        accountId: accountId ?? '-1', // -1 unassigns in Jira
      });
    } catch (error) {
      throw wrapJiraError(error, `Failed to assign issue ${keyOrId}`);
    }
  }
}

/**
 * Create issue operations instance
 */
export function createIssueOperations(client: JiraClient): IssueOperations {
  return new IssueOperations(client);
}
