# Research: @generacy-ai/generacy-plugin-jira

## Technology Decisions

### API Client Library

**Decision**: Use `jira.js` (official Atlassian SDK)

**Alternatives Considered**:

| Option | Pros | Cons |
|--------|------|------|
| **jira.js** (chosen) | Official SDK, full TypeScript support, handles auth/pagination | Larger bundle size |
| node-fetch + manual | Full control, smaller bundle | Must implement auth, pagination, retries manually |
| axios | Familiar, interceptors | No Jira-specific types, manual everything |

**Rationale**: `jira.js` provides complete TypeScript definitions matching Jira Cloud's V3 API, handles authentication flows, and is maintained by Atlassian. The time saved on boilerplate justifies the dependency.

### Authentication

**Decision**: Basic Auth with email + API token (initial implementation)

**Reasoning**:
- Covers 90%+ of use cases for API automation
- Simple to configure and understand
- No OAuth flow complexity
- API tokens are scoped and revocable
- OAuth 2.0 can be added later as `auth: AuthStrategy` without interface changes

**Security Note**: API tokens have the same permissions as the user account. Recommend using a dedicated service account with minimal required permissions.

### Pagination Strategy

**Decision**: Async Iterator for JQL search, auto-fetch for list operations

**Pattern**:
```typescript
// JQL search returns AsyncGenerator for memory efficiency
async function* searchIssues(jql: string): AsyncGenerator<JiraIssue> {
  // Yields issues one page at a time
}

// List operations (used less frequently) auto-fetch all
async function listProjectIssues(projectKey: string): Promise<JiraIssue[]> {
  // Fetches all pages into array
}
```

**Rationale**: JQL searches can return thousands of issues. An async iterator allows consumers to:
- Process issues as they arrive
- Stop early if they find what they need
- Avoid OOM on large result sets

### ADF (Atlassian Document Format)

**Decision**: Accept both plain text and ADF, convert plain text internally

**Conversion Strategy**:
```typescript
function ensureAdf(input: string | AdfDocument): AdfDocument {
  if (typeof input === 'string') {
    return {
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: input }] }]
    };
  }
  return input;
}
```

**Markdown to ADF**: Consider adding optional `markdownToAdf()` utility for common use cases (code blocks, lists, links).

### Error Handling

**Decision**: Typed exception classes matching Jira error categories

**Error Hierarchy**:
```
JiraPluginError (base)
├── JiraAuthError              - 401 Unauthorized
├── JiraForbiddenError         - 403 Forbidden (permissions)
├── JiraNotFoundError          - 404 Issue/project not found
├── JiraValidationError        - 400 Bad request, field validation
├── JiraRateLimitError         - 429 Rate limited
├── JiraTransitionError        - Invalid workflow transition
└── JiraConnectionError        - Network failures
```

**HTTP Status Mapping**:
| Status | Error Class |
|--------|-------------|
| 400 | JiraValidationError |
| 401 | JiraAuthError |
| 403 | JiraForbiddenError |
| 404 | JiraNotFoundError |
| 429 | JiraRateLimitError |
| 5xx | JiraConnectionError |

## Implementation Patterns

### Client Wrapper

Follow the GitHub Issues plugin pattern:

```typescript
export class JiraClient {
  private readonly client: Version3Client;
  private readonly config: ValidatedConfig;

  constructor(config: JiraConfig) {
    this.config = validateConfig(config);
    this.client = new Version3Client({
      host: `https://${this.config.host}`,
      authentication: {
        basic: { email: this.config.email, apiToken: this.config.apiToken }
      }
    });
  }

  async request<T>(operation: () => Promise<T>, context?: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.wrapError(error, context);
    }
  }
}
```

### Operations Layer

Separate operation modules for different concerns:

```typescript
// operations/issues.ts
export interface IssueOperations {
  create(params: CreateJiraIssueParams): Promise<JiraIssue>;
  get(key: string): Promise<JiraIssue>;
  update(key: string, params: UpdateJiraIssueParams): Promise<JiraIssue>;
  delete(key: string): Promise<void>;
  transition(key: string, transitionId: string): Promise<void>;
}

export function createIssueOperations(client: JiraClient): IssueOperations {
  return {
    async create(params) { /* ... */ },
    async get(key) { /* ... */ },
    // ...
  };
}
```

### Type Mapping

Jira API returns verbose objects. Map to clean interfaces:

```typescript
function mapIssue(raw: ApiIssue): JiraIssue {
  return {
    id: raw.id,
    key: raw.key,
    summary: raw.fields.summary,
    description: raw.fields.description, // Already ADF
    status: {
      id: raw.fields.status.id,
      name: raw.fields.status.name,
      statusCategory: raw.fields.status.statusCategory,
    },
    // ... map all fields
  };
}
```

## Jira Cloud API Reference

### Base URL
```
https://{site}.atlassian.net/rest/api/3
```

### Key Endpoints

| Operation | Method | Endpoint |
|-----------|--------|----------|
| Create issue | POST | `/issue` |
| Get issue | GET | `/issue/{issueIdOrKey}` |
| Update issue | PUT | `/issue/{issueIdOrKey}` |
| Delete issue | DELETE | `/issue/{issueIdOrKey}` |
| Search (JQL) | POST | `/search` |
| Get transitions | GET | `/issue/{issueIdOrKey}/transitions` |
| Do transition | POST | `/issue/{issueIdOrKey}/transitions` |
| Add comment | POST | `/issue/{issueIdOrKey}/comment` |
| Get project | GET | `/project/{projectIdOrKey}` |
| Get sprints | GET | `/board/{boardId}/sprint` |

### Rate Limits

- **Rate limit header**: `X-RateLimit-Remaining`
- **Typical limits**: ~10 requests/second for most endpoints
- **Bulk operations**: May have lower limits
- **Recommendation**: Implement exponential backoff with jitter

### Pagination

```typescript
// Request
{
  "jql": "project = PROJ ORDER BY created DESC",
  "startAt": 0,
  "maxResults": 50,
  "fields": ["summary", "status", "assignee"]
}

// Response
{
  "startAt": 0,
  "maxResults": 50,
  "total": 234,
  "issues": [...]
}
```

## Webhook Integration

### Registering Webhooks

Webhooks are configured in Jira admin or via API:

```typescript
// POST /rest/webhooks/1.0/webhook
{
  "name": "Generacy Integration",
  "url": "https://your-server.com/webhooks/jira",
  "events": ["jira:issue_created", "jira:issue_updated"],
  "filters": {
    "issue-related-events-section": "project = PROJ"
  }
}
```

### Webhook Payload

```typescript
{
  "timestamp": 1642521600000,
  "webhookEvent": "jira:issue_updated",
  "user": { "accountId": "...", "displayName": "..." },
  "issue": { "id": "10001", "key": "PROJ-123", ... },
  "changelog": {
    "id": "10002",
    "items": [{
      "field": "status",
      "fieldtype": "jira",
      "from": "10000",
      "fromString": "To Do",
      "to": "10001",
      "toString": "In Progress"
    }]
  }
}
```

### Signature Verification (Optional)

Jira Cloud doesn't use HMAC signatures like GitHub. Instead:
- Use webhook secret as a query parameter or header
- Validate IP ranges (Atlassian published IPs)
- Use mutual TLS for high-security needs

## Testing Strategy

### Unit Tests
- Mock `jira.js` client responses
- Test error wrapping
- Test type mapping
- Test ADF conversion

### Integration Tests
- Use Jira Cloud sandbox project
- Test CRUD operations
- Test search pagination
- Test webhook parsing

### Test Fixtures

Create JSON fixtures from real Jira API responses:
```
test/fixtures/
├── issue-story.json
├── issue-epic.json
├── search-results.json
├── transitions.json
└── webhook-issue-updated.json
```

## References

- [Jira Cloud REST API v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
- [jira.js Documentation](https://mrrefactoring.github.io/jira.js/)
- [Atlassian Document Format (ADF)](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)
- [Webhooks for Jira Cloud](https://developer.atlassian.com/cloud/jira/platform/webhooks/)
- [Authentication for REST APIs](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/)
