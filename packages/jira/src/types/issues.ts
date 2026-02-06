import type { AdfDocument } from './events.js';
import type { JiraStatus } from './workflows.js';
import type { Sprint } from './sprints.js';
import type { ProjectRef } from './projects.js';

/**
 * Jira user representation
 */
export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress: string | null;
  avatarUrls: {
    '16x16': string;
    '24x24': string;
    '32x32': string;
    '48x48': string;
  };
  active: boolean;
}

/**
 * Issue type definition
 */
export interface IssueType {
  id: string;
  name: string;
  description: string;
  iconUrl: string;
  subtask: boolean;
  hierarchyLevel: number;
}

/**
 * Issue priority
 */
export interface Priority {
  id: string;
  name: string;
  iconUrl: string;
}

/**
 * Reference to another issue (lightweight)
 */
export interface IssueRef {
  id: string;
  key: string;
  self: string;
}

/**
 * Component reference
 */
export interface Component {
  id: string;
  name: string;
  description?: string;
}

/**
 * Issue link relationship
 */
export interface IssueLink {
  id: string;
  type: {
    id: string;
    name: string;
    inward: string;
    outward: string;
  };
  inwardIssue?: IssueRef;
  outwardIssue?: IssueRef;
}

/**
 * Full Jira issue representation
 */
export interface JiraIssue {
  id: string;
  key: string;
  self: string;

  // Core fields
  summary: string;
  description: AdfDocument | null;
  status: JiraStatus;
  issueType: IssueType;
  priority: Priority;

  // People
  reporter: JiraUser;
  assignee: JiraUser | null;

  // Relationships
  project: ProjectRef;
  parent: IssueRef | null;
  subtasks: IssueRef[];
  linkedIssues: IssueLink[];

  // Time tracking
  created: string;
  updated: string;
  dueDate: string | null;

  // Sprint (if Agile)
  sprint: Sprint | null;

  // Labels and components
  labels: string[];
  components: Component[];

  // Custom fields (dynamic)
  customFields: Record<string, unknown>;
}

/**
 * Parameters for creating a new issue
 */
export interface CreateJiraIssueParams {
  projectKey: string;
  summary: string;
  description?: string | AdfDocument;
  issueType: string;
  priority?: string;
  assignee?: string;
  labels?: string[];
  components?: string[];
  dueDate?: string;
  parentKey?: string;
  customFields?: Record<string, unknown>;
}

/**
 * Parameters for updating an issue
 */
export interface UpdateJiraIssueParams {
  summary?: string;
  description?: string | AdfDocument;
  priority?: string;
  assignee?: string | null;
  labels?: string[];
  components?: string[];
  dueDate?: string | null;
  customFields?: Record<string, unknown>;
}

/**
 * JQL search options
 */
export interface SearchOptions {
  /** Fields to include in response */
  fields?: string[];

  /** Expand additional data (changelog, names, etc.) */
  expand?: string[];

  /** Page size (default: 50, max: 100) */
  pageSize?: number;

  /** Starting index (for manual pagination) */
  startAt?: number;

  /** Validate JQL syntax before searching */
  validateQuery?: boolean;
}
