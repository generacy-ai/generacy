# Data Model: @generacy-ai/generacy-plugin-jira

## Core Entities

### JiraIssue

Represents a Jira issue (Story, Bug, Task, Epic, etc.)

```typescript
interface JiraIssue {
  id: string;                        // Jira internal ID
  key: string;                       // Project key + number (e.g., "PROJ-123")
  self: string;                      // API URL

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
  parent: IssueRef | null;           // Epic or parent issue
  subtasks: IssueRef[];
  linkedIssues: IssueLink[];

  // Time tracking
  created: string;                   // ISO 8601
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
```

### JiraUser

```typescript
interface JiraUser {
  accountId: string;                 // Atlassian account ID
  displayName: string;
  emailAddress: string | null;       // May be hidden
  avatarUrls: {
    '16x16': string;
    '24x24': string;
    '32x32': string;
    '48x48': string;
  };
  active: boolean;
}
```

### JiraStatus

```typescript
interface JiraStatus {
  id: string;
  name: string;                      // e.g., "In Progress"
  description: string | null;
  statusCategory: StatusCategory;
}

interface StatusCategory {
  id: number;
  key: 'new' | 'indeterminate' | 'done';
  name: string;
  colorName: string;
}
```

### IssueType

```typescript
interface IssueType {
  id: string;
  name: string;                      // e.g., "Story", "Bug", "Task"
  description: string;
  iconUrl: string;
  subtask: boolean;
  hierarchyLevel: number;
}
```

### Transition

```typescript
interface Transition {
  id: string;
  name: string;                      // e.g., "Start Progress"
  to: JiraStatus;
  hasScreen: boolean;
  isGlobal: boolean;
  isInitial: boolean;
  isConditional: boolean;
  fields?: Record<string, TransitionField>;
}

interface TransitionField {
  required: boolean;
  schema: FieldSchema;
  name: string;
  operations: string[];
  allowedValues?: unknown[];
}
```

### Sprint

```typescript
interface Sprint {
  id: number;
  self: string;
  state: 'active' | 'closed' | 'future';
  name: string;
  startDate: string | null;
  endDate: string | null;
  completeDate: string | null;
  originBoardId: number;
  goal: string | null;
}
```

### Comment

```typescript
interface JiraComment {
  id: string;
  self: string;
  author: JiraUser;
  body: AdfDocument;                 // Always ADF in Jira Cloud
  created: string;
  updated: string;
  visibility: CommentVisibility | null;
}

interface CommentVisibility {
  type: 'group' | 'role';
  value: string;
}
```

### Custom Field

```typescript
interface CustomField {
  id: string;                        // e.g., "customfield_10001"
  key: string;                       // e.g., "com.atlassian.jira.plugin.system.customfieldtypes:textfield"
  name: string;                      // Human-readable name
  description: string | null;
  type: CustomFieldType;
  schema: FieldSchema;
}

type CustomFieldType =
  | 'string'
  | 'number'
  | 'date'
  | 'datetime'
  | 'user'
  | 'select'
  | 'multiselect'
  | 'labels'
  | 'cascadingselect'
  | 'array';

interface FieldSchema {
  type: string;
  items?: string;
  custom?: string;
  customId?: number;
  system?: string;
}
```

### Atlassian Document Format (ADF)

```typescript
interface AdfDocument {
  version: 1;
  type: 'doc';
  content: AdfNode[];
}

type AdfNode =
  | AdfParagraph
  | AdfHeading
  | AdfCodeBlock
  | AdfBulletList
  | AdfOrderedList
  | AdfTable
  | AdfPanel
  | AdfBlockquote;

interface AdfParagraph {
  type: 'paragraph';
  content?: AdfInlineNode[];
}

interface AdfHeading {
  type: 'heading';
  attrs: { level: 1 | 2 | 3 | 4 | 5 | 6 };
  content?: AdfInlineNode[];
}

interface AdfCodeBlock {
  type: 'codeBlock';
  attrs?: { language?: string };
  content?: AdfTextNode[];
}

type AdfInlineNode = AdfTextNode | AdfHardBreak | AdfMention | AdfEmoji | AdfInlineCard;

interface AdfTextNode {
  type: 'text';
  text: string;
  marks?: AdfMark[];
}

type AdfMark =
  | { type: 'strong' }
  | { type: 'em' }
  | { type: 'code' }
  | { type: 'strike' }
  | { type: 'underline' }
  | { type: 'link'; attrs: { href: string; title?: string } };
```

## Configuration Types

### JiraConfig

```typescript
interface JiraConfig {
  /** Jira Cloud host URL (e.g., "company.atlassian.net") */
  host: string;

  /** Atlassian account email */
  email: string;

  /** Jira API token */
  apiToken: string;

  /** Default project key for operations */
  projectKey?: string;

  /** Map Generacy issue types to Jira issue types */
  issueTypeMapping?: {
    feature: string;    // Default: "Story"
    bug: string;        // Default: "Bug"
    task: string;       // Default: "Task"
    epic: string;       // Default: "Epic"
  };

  /** Map workflow states to Jira status IDs */
  workflowMapping?: {
    todo: string;
    inProgress: string;
    done: string;
  };

  /** Webhook secret for signature verification */
  webhookSecret?: string;

  /** Timeout for API requests (ms) */
  timeout?: number;
}
```

## Operation Parameters

### CreateJiraIssueParams

```typescript
interface CreateJiraIssueParams {
  projectKey: string;
  summary: string;
  description?: string | AdfDocument;
  issueType: string;
  priority?: string;
  assignee?: string;                 // Account ID
  labels?: string[];
  components?: string[];
  dueDate?: string;
  parentKey?: string;                // For subtasks or Epic children
  customFields?: Record<string, unknown>;
}
```

### UpdateJiraIssueParams

```typescript
interface UpdateJiraIssueParams {
  summary?: string;
  description?: string | AdfDocument;
  priority?: string;
  assignee?: string | null;
  labels?: string[];
  components?: string[];
  dueDate?: string | null;
  customFields?: Record<string, unknown>;
}
```

### SearchOptions

```typescript
interface SearchOptions {
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
```

### AddCommentParams

```typescript
interface AddCommentParams {
  body: string | AdfDocument;
  visibility?: {
    type: 'group' | 'role';
    value: string;
  };
}
```

## Webhook Event Types

```typescript
interface JiraWebhookEvent {
  webhookEvent: JiraEventType;
  timestamp: number;
  user: JiraUser;
  issue?: JiraIssue;
  changelog?: Changelog;
  comment?: JiraComment;
}

type JiraEventType =
  | 'jira:issue_created'
  | 'jira:issue_updated'
  | 'jira:issue_deleted'
  | 'comment_created'
  | 'comment_updated'
  | 'comment_deleted'
  | 'sprint_created'
  | 'sprint_updated'
  | 'sprint_started'
  | 'sprint_closed';

interface Changelog {
  id: string;
  items: ChangelogItem[];
}

interface ChangelogItem {
  field: string;
  fieldtype: string;
  fieldId: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
}
```

## Validation Schemas (Zod)

```typescript
// Config validation
const JiraConfigSchema = z.object({
  host: z.string().url(),
  email: z.string().email(),
  apiToken: z.string().min(1),
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  issueTypeMapping: z.object({
    feature: z.string().default('Story'),
    bug: z.string().default('Bug'),
    task: z.string().default('Task'),
    epic: z.string().default('Epic'),
  }).optional(),
  workflowMapping: z.object({
    todo: z.string(),
    inProgress: z.string(),
    done: z.string(),
  }).optional(),
  webhookSecret: z.string().optional(),
  timeout: z.number().positive().optional(),
});

// Issue creation validation
const CreateJiraIssueParamsSchema = z.object({
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  summary: z.string().min(1).max(255),
  description: z.union([z.string(), AdfDocumentSchema]).optional(),
  issueType: z.string().min(1),
  priority: z.string().optional(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
  components: z.array(z.string()).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  parentKey: z.string().optional(),
  customFields: z.record(z.unknown()).optional(),
});
```

## Relationships

```
JiraIssue
├── belongs_to Project
├── belongs_to IssueType
├── belongs_to JiraStatus
├── belongs_to Priority
├── has_one reporter (JiraUser)
├── has_one assignee (JiraUser, nullable)
├── has_one parent (IssueRef, nullable)
├── has_many subtasks (IssueRef[])
├── has_many comments (JiraComment[])
├── has_many linkedIssues (IssueLink[])
├── has_one sprint (Sprint, nullable)
└── has_many customFields (dynamic)

Sprint
├── belongs_to Board
└── has_many issues (JiraIssue[])

Transition
├── from JiraStatus (current)
└── to JiraStatus (target)
```
