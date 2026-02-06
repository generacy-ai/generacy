# Implementation Plan: @generacy-ai/generacy-plugin-jira

**Feature**: Atlassian Jira integration plugin for Generacy
**Branch**: `015-plugin-generacy-ai-generacy`
**Status**: Complete

## Summary

Implement a Jira Cloud integration plugin that provides programmatic access to Jira issues, following the same architectural patterns established by the `@generacy-ai/generacy-plugin-github-issues` package. The plugin will support issue CRUD, JQL search, workflow transitions, custom fields, sprint management, and webhook handling.

## Clarification Decisions

Based on answers from issue #15:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Authentication | Basic Auth only (email + API token) | Simpler implementation, covers most use cases. OAuth 2.0 can be added later. |
| Error Handling | Throw typed exceptions | Matches existing GitHub Issues plugin pattern. |
| Pagination | Async iterator for JQL search | Memory efficient, base interface auto-fetches. |
| Comments | Both plain text and ADF | Plain text for base interface, ADF for advanced usage. |
| Webhook Verification | Optional helper utility | Verification is a cross-cutting concern, not forced. |

## Technical Context

- **Language**: TypeScript (ES Modules)
- **Runtime**: Node.js 20+
- **Build**: tsc
- **Testing**: Vitest
- **HTTP Client**: `jira.js` (official Atlassian SDK) or `node-fetch`
- **Validation**: Zod schemas
- **Package Manager**: pnpm (workspace)

## Dependencies

### Production
- `jira.js` - Official Atlassian Jira Cloud API client
- `zod` - Runtime schema validation

### Development
- `@types/node` - Node.js type definitions
- `typescript` - TypeScript compiler
- `vitest` - Test runner

## Project Structure

```
packages/jira/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                 # Public API exports
│   ├── plugin.ts                # JiraPlugin class
│   ├── client.ts                # Jira API client wrapper
│   ├── types/
│   │   ├── index.ts             # Re-exports
│   │   ├── config.ts            # JiraConfig interface + schema
│   │   ├── issues.ts            # Issue types + schemas
│   │   ├── projects.ts          # Project/board types
│   │   ├── sprints.ts           # Sprint types
│   │   ├── workflows.ts         # Transition types
│   │   ├── custom-fields.ts     # Custom field types
│   │   └── events.ts            # Webhook event types
│   ├── operations/
│   │   ├── issues.ts            # Issue CRUD operations
│   │   ├── search.ts            # JQL search with async iterator
│   │   ├── comments.ts          # Comment operations (ADF support)
│   │   ├── transitions.ts       # Workflow transitions
│   │   ├── custom-fields.ts     # Custom field operations
│   │   └── sprints.ts           # Sprint operations
│   ├── utils/
│   │   ├── errors.ts            # Typed error classes
│   │   ├── validation.ts        # Config/param validation
│   │   ├── adf.ts               # ADF conversion utilities
│   │   └── jql-builder.ts       # JQL query builder helper
│   └── webhooks/
│       ├── handler.ts           # Webhook event handler
│       ├── parser.ts            # Event payload parsing
│       ├── verify.ts            # Optional signature verification
│       └── types.ts             # Webhook-specific types
└── test/
    ├── plugin.test.ts
    ├── client.test.ts
    ├── operations/
    │   └── *.test.ts
    └── fixtures/
        └── *.json
```

## Key Technical Decisions

### 1. API Client Strategy

Use `jira.js` as the underlying HTTP client:
- Official Atlassian SDK with TypeScript support
- Handles authentication, retries, and pagination
- Well-maintained and documented

```typescript
import { Version3Client } from 'jira.js';

const client = new Version3Client({
  host: config.host,
  authentication: {
    basic: { email: config.email, apiToken: config.apiToken }
  }
});
```

### 2. Error Hierarchy

Follow the GitHub Issues plugin pattern:

```typescript
class JiraPluginError extends Error { code: string; cause?: unknown }
class JiraAuthError extends JiraPluginError { }
class JiraRateLimitError extends JiraPluginError { resetAt?: Date }
class JiraNotFoundError extends JiraPluginError { }
class JiraValidationError extends JiraPluginError { details?: Record<string, string[]> }
class JiraTransitionError extends JiraPluginError { availableTransitions?: Transition[] }
```

### 3. Async Iterator for Search

```typescript
async function* searchIssues(jql: string, options?: SearchOptions): AsyncGenerator<JiraIssue> {
  let startAt = 0;
  const maxResults = options?.pageSize ?? 50;

  while (true) {
    const response = await client.issueSearch.searchForIssuesUsingJql({
      jql,
      startAt,
      maxResults,
      fields: options?.fields ?? ['*all']
    });

    for (const issue of response.issues ?? []) {
      yield mapIssue(issue);
    }

    if (!response.issues?.length || startAt + response.issues.length >= (response.total ?? 0)) {
      break;
    }
    startAt += response.issues.length;
  }
}
```

### 4. ADF Conversion

Plain text to ADF for the base `addComment(issueId, comment: string)` interface:

```typescript
function textToAdf(text: string): AdfDocument {
  return {
    version: 1,
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text }]
    }]
  };
}
```

### 5. Configuration Schema

```typescript
const JiraConfigSchema = z.object({
  host: z.string().url('Host must be a valid URL'),
  email: z.string().email('Valid email required'),
  apiToken: z.string().min(1, 'API token is required'),
  projectKey: z.string().optional(),
  issueTypeMapping: z.object({
    feature: z.string().default('Story'),
    bug: z.string().default('Bug'),
    task: z.string().default('Task'),
  }).optional(),
  workflowMapping: z.object({
    todo: z.string(),
    inProgress: z.string(),
    done: z.string(),
  }).optional(),
});
```

## Implementation Phases

### Phase 1: Foundation
- Package setup (package.json, tsconfig.json)
- Types: config, issues, responses
- Client wrapper with Basic Auth
- Error classes

### Phase 2: Core Operations
- Issue CRUD (create, get, update, transition)
- JQL search with async iterator
- Comment operations with ADF support

### Phase 3: Advanced Features
- Custom field operations
- Sprint operations (get active, add issue)
- Project/board utilities

### Phase 4: Webhooks
- Webhook event types
- Event parser
- Handler with action detection
- Optional verification helper

### Phase 5: Integration
- Plugin class (facade)
- Public API exports
- Tests and documentation

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Jira API changes | Use official `jira.js` SDK with version pinning |
| Rate limiting | Implement retry logic with exponential backoff |
| Large result sets | Async iterator prevents memory exhaustion |
| Custom field complexity | Provide type-safe wrapper with runtime validation |

## Out of Scope

- OAuth 2.0 authentication (future enhancement)
- Jira Server/Data Center support (Cloud only)
- Confluence integration
- Advanced project management (roadmaps, etc.)
