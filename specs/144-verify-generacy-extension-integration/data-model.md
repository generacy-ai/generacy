# Data Model: Generacy Extension Integration

## Core Entities

### AuthTokens
Represents authentication credentials stored by the extension.

```typescript
interface AuthTokens {
  accessToken: string;      // JWT access token
  refreshToken: string;     // Token for refreshing access
  expiresAt: number;        // Unix timestamp of expiration
  tokenType: 'Bearer';      // Always Bearer for JWT
}
```

### Organization
Represents a Generacy organization/team.

```typescript
interface Organization {
  id: string;                            // UUID
  name: string;                          // Display name
  slug: string;                          // URL-safe identifier
  tier: 'starter' | 'team' | 'enterprise';
  seats: number;                         // Licensed seats
  maxConcurrentAgents: number;           // Agent limit
  createdAt: string;                     // ISO8601
}
```

### OrgMember
Represents a user's membership in an organization.

```typescript
interface OrgMember {
  userId: string;           // User ID
  user: User;               // Embedded user profile
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;         // ISO8601
}
```

### User
Represents an authenticated user.

```typescript
interface User {
  id: string;               // UUID
  email?: string;           // Optional email
  name: string;             // Display name
  avatarUrl?: string;       // Profile picture URL
  githubUsername?: string;  // GitHub identity
}
```

### Workflow
Represents a workflow execution instance.

```typescript
interface Workflow {
  id: string;                           // UUID
  status: WorkflowStatus;               // Current state
  currentStep?: string;                 // Active step ID
  context: Record<string, unknown>;     // Workflow variables
  metadata: WorkflowMetadata;           // Name, tags
  createdAt: string;                    // ISO8601
  updatedAt: string;                    // ISO8601
  completedAt?: string;                 // ISO8601 if finished
}

type WorkflowStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

interface WorkflowMetadata {
  name?: string;            // Human-readable name
  tags?: string[];          // Categorization tags
}
```

### QueueItem
Represents a decision awaiting user input.

```typescript
interface QueueItem {
  id: string;                           // UUID
  workflowId: string;                   // Parent workflow
  stepId: string;                       // Originating step
  type: DecisionType;                   // Kind of decision
  prompt: string;                       // Question text
  options?: DecisionOption[];           // Available choices
  context: Record<string, unknown>;     // Decision context
  priority: DecisionPriority;           // Urgency level
  createdAt: string;                    // ISO8601
  dueAt?: string;                       // Optional deadline
}

type DecisionType =
  | 'approval'   // Yes/No approval
  | 'choice'     // Multiple choice
  | 'input'      // Free-form input
  | 'review';    // Content review

type DecisionPriority =
  | 'blocking_now'     // Immediate attention
  | 'blocking_soon'    // Within hours
  | 'when_available';  // At convenience

interface DecisionOption {
  id: string;           // Option identifier
  label: string;        // Display text
  description?: string; // Help text
}
```

### Integration
Represents an external service connection.

```typescript
interface Integration {
  type: IntegrationType;    // Service identifier
  connected: boolean;       // Connection status
  connectedAt?: string;     // When connected (ISO8601)
  expiresAt?: string;       // Token expiration
  metadata?: Record<string, unknown>;
}

type IntegrationType =
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'jira'
  | 'linear';
```

### PublishedWorkflow
Represents a workflow definition published to the registry.

```typescript
interface PublishedWorkflow {
  name: string;                 // Unique workflow name
  latestVersion: number;        // Current version number
  latestTag?: string;           // Semantic version tag
  versions: WorkflowVersion[];  // Version history
  createdAt: string;            // ISO8601
  updatedAt: string;            // ISO8601
}

interface WorkflowVersion {
  version: number;          // Sequential version number
  tag?: string;             // e.g., "1.0.0"
  publishedAt: string;      // ISO8601
  publishedBy: string;      // User ID
  changelog?: string;       // Version notes
}
```

## Validation Rules

### AuthTokens
- `accessToken`: Non-empty JWT string
- `refreshToken`: Non-empty string
- `expiresAt`: Future timestamp (for valid tokens)

### Organization
- `id`: Valid UUID format
- `name`: 1-100 characters
- `slug`: Lowercase alphanumeric with hyphens, 1-50 chars
- `seats`: Positive integer
- `maxConcurrentAgents`: Positive integer

### Workflow
- `id`: Valid UUID format
- `status`: One of defined WorkflowStatus values
- `context`: Valid JSON object
- `createdAt`: Valid ISO8601 timestamp

### QueueItem
- `id`: Valid UUID format
- `workflowId`: Valid UUID referencing existing workflow
- `prompt`: Non-empty string, max 1000 chars
- `options`: If present, at least 2 options for 'choice' type

## Entity Relationships

```
┌─────────────────┐
│   User          │
└────────┬────────┘
         │ 1:N
         ▼
┌─────────────────┐      ┌─────────────────┐
│   OrgMember     │◄────►│  Organization   │
└─────────────────┘  N:1 └────────┬────────┘
                                  │ 1:N
                                  ▼
                         ┌─────────────────┐
                         │   Workflow      │
                         └────────┬────────┘
                                  │ 1:N
                                  ▼
                         ┌─────────────────┐
                         │   QueueItem     │
                         └─────────────────┘

┌─────────────────┐
│  Integration    │──── Connected to Organization
└─────────────────┘

┌─────────────────┐
│PublishedWorkflow│──── Published by User
└─────────────────┘
```

## Zod Schemas (from extension)

The extension uses these Zod schemas for runtime validation:

```typescript
// packages/generacy-extension/src/api/types.ts

export const AuthTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
  tokenType: z.literal('Bearer'),
});

export const OrganizationSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  tier: z.enum(['starter', 'team', 'enterprise']),
  seats: z.number().int().positive(),
  maxConcurrentAgents: z.number().int().positive(),
  createdAt: z.string().datetime(),
});

export const WorkflowSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['created', 'running', 'paused', 'completed', 'cancelled', 'failed']),
  currentStep: z.string().optional(),
  context: z.record(z.unknown()),
  metadata: z.object({
    name: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});

export const QueueItemSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid(),
  stepId: z.string(),
  type: z.enum(['approval', 'choice', 'input', 'review']),
  prompt: z.string().min(1).max(1000),
  options: z.array(z.object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
  })).optional(),
  context: z.record(z.unknown()),
  priority: z.enum(['blocking_now', 'blocking_soon', 'when_available']),
  createdAt: z.string().datetime(),
  dueAt: z.string().datetime().optional(),
});
```
