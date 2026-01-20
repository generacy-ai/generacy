# Research: @generacy-ai/generacy-plugin-github-issues

## Technology Decisions

### GitHub API Client: Octokit

**Decision**: Use `@octokit/rest` as the GitHub API client.

**Rationale**:
- Official GitHub SDK with TypeScript support
- Handles authentication, rate limiting, and pagination automatically
- Comprehensive type definitions via `@octokit/types`
- `@octokit/webhooks` companion package for event handling
- Active maintenance and ecosystem support

**Alternatives Considered**:
| Alternative | Pros | Cons | Verdict |
|-------------|------|------|---------|
| Raw `fetch` | No dependencies | Manual auth, pagination, types | Rejected |
| `graphql-request` | Better for complex queries | REST is simpler for CRUD | Rejected |
| `node-fetch` + custom wrapper | Full control | Significant development effort | Rejected |

### Validation: Zod

**Decision**: Use Zod for runtime schema validation.

**Rationale**:
- Already used in the orchestrator package
- TypeScript-first with excellent inference
- Clear error messages
- Small bundle size

### Authentication: PAT Token First

**Decision**: Start with Personal Access Token support, design for future GitHub App support.

**Rationale**:
- PAT is simpler to implement and test
- GitHub App requires additional infrastructure (private key storage, JWT generation)
- The client interface can abstract auth method behind `token` parameter
- Future: Add `GitHubAppAuth` class that generates installation tokens

**GitHub App Considerations**:
```typescript
// Future interface for GitHub App auth
interface GitHubAppConfig {
  appId: number;
  privateKey: string;
  installationId: number;
}

// Token can be either PAT or generated from App
type AuthToken = string | GitHubAppConfig;
```

### Webhook Processing Model

**Decision**: Stateless webhook handler that receives parsed events.

**Rationale**:
- Decouples plugin from HTTP infrastructure
- Works with any delivery mechanism (HTTP, queue, WebSocket)
- Easier to test (no HTTP mocking needed)
- Consumer responsibility to verify signatures if needed

**Pattern**:
```typescript
// Plugin receives already-parsed webhook
const action = await plugin.handleWebhook({
  name: 'issues',
  payload: { action: 'assigned', ... }
});

// Consumer handles HTTP/signature verification
app.post('/webhook', async (req, res) => {
  const verified = verifySignature(req, secret);
  if (!verified) return res.status(401).send();

  const event = parseEvent(req);
  await plugin.handleWebhook(event);
  res.status(200).send();
});
```

## Implementation Patterns

### Error Handling Pattern

Wrap Octokit errors in domain-specific error classes:

```typescript
async function withErrorHandling<T>(
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error.status === 401) {
      throw new GitHubAuthError('Invalid authentication token');
    }
    if (error.status === 403 && error.headers['x-ratelimit-remaining'] === '0') {
      throw new GitHubRateLimitError(error.headers['x-ratelimit-reset']);
    }
    if (error.status === 404) {
      throw new GitHubNotFoundError(error.message);
    }
    throw new GitHubApiError(error.message, error.status);
  }
}
```

### Pagination Pattern

Use Octokit's built-in pagination:

```typescript
async listIssues(filter?: IssueFilter): Promise<Issue[]> {
  return this.octokit.paginate(
    this.octokit.rest.issues.listForRepo,
    {
      owner: this.config.owner,
      repo: this.config.repo,
      state: filter?.state ?? 'open',
      per_page: 100,
    }
  );
}
```

### Workflow Trigger Pattern

Evaluate events against configured triggers:

```typescript
interface TriggerRule {
  event: string;
  action?: string;
  condition?: (payload: any) => boolean;
  result: WorkflowAction;
}

const defaultTriggers: TriggerRule[] = [
  {
    event: 'issues',
    action: 'assigned',
    condition: (p) => p.assignee?.login === config.agentAccount,
    result: { type: 'queue_for_processing', issueNumber: 'from_payload' }
  },
  {
    event: 'issues',
    action: 'labeled',
    condition: (p) => config.triggerLabels?.includes(p.label?.name),
    result: { type: 'start_workflow', issueNumber: 'from_payload' }
  },
];
```

## Key Sources & References

### Official Documentation
- [Octokit REST.js](https://github.com/octokit/rest.js)
- [GitHub REST API](https://docs.github.com/en/rest)
- [GitHub Webhooks](https://docs.github.com/en/webhooks)
- [GitHub Apps](https://docs.github.com/en/apps)

### Type Definitions
- [@octokit/types](https://github.com/octokit/types.ts)
- [@octokit/webhooks-types](https://github.com/octokit/webhooks)

### Similar Implementations
- [Probot](https://github.com/probot/probot) - GitHub App framework
- [octokit/plugin-rest-endpoint-methods](https://github.com/octokit/plugin-rest-endpoint-methods.js)

## Open Questions (Resolved)

1. ~~Plugin interface from Core~~ → Standalone initially, adapt when Core is available
2. ~~Webhook receiver architecture~~ → Plugin is consumer, infrastructure is external
3. ~~Auth method priority~~ → PAT first, App later
4. ~~Event streaming mechanism~~ → Consumer pushes events to plugin
5. ~~MVP scope~~ → All CRUD + webhooks, templates are enhancement

---

*Generated by speckit*
