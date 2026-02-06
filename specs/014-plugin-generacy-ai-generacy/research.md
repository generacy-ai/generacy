# Research: @generacy-ai/generacy-plugin-copilot

## GitHub Copilot Workspace API Status

### Current State (2026-02)

**API Availability**: GitHub Copilot Workspace does not currently have a public API. The service is available through:
- GitHub web interface (github.com)
- VS Code extension integration
- GitHub Mobile app

**Implications for This Plugin**:
- Cannot programmatically create workspaces
- Cannot poll workspace status via API
- Cannot retrieve changes or PRs directly from workspace

### Potential Future APIs

GitHub's API evolution suggests possible future endpoints:
1. REST API v4 extensions for Copilot features
2. GraphQL API additions
3. GitHub Apps webhooks for Copilot events

## Alternative Integration Approaches

### Option A: Manual Trigger + PR Monitoring (Recommended for v1)

**Approach**:
1. Plugin creates/updates a GitHub Issue with structured metadata
2. User manually opens Copilot Workspace for that issue
3. Plugin monitors the repository for PRs linked to the issue
4. Uses GitHub PR API to track status and retrieve changes

**Pros**:
- Works with current GitHub APIs
- No browser automation needed
- Reliable status tracking

**Cons**:
- Requires manual step to open workspace
- Cannot automate the actual Copilot invocation

### Option B: Browser Automation

**Approach**:
- Use Playwright to automate Copilot Workspace UI
- Navigate to issue, click "Open in Copilot Workspace"
- Poll for completion via DOM observation

**Pros**:
- Full automation possible

**Cons**:
- Fragile (UI changes break automation)
- Rate limiting/bot detection risks
- Complex infrastructure requirements
- Authentication challenges

### Option C: VS Code Extension Bridge

**Approach**:
- Create companion VS Code extension
- Bridge Copilot Workspace commands via extension API
- Communicate with plugin via IPC/HTTP

**Pros**:
- Uses official extension APIs

**Cons**:
- Requires VS Code running
- Complex multi-process architecture
- Not suitable for headless operation

## Technology Decisions

### 1. GitHub API Client

**Choice**: @octokit/rest

**Rationale**:
- Already used by github-issues plugin
- Well-maintained, TypeScript support
- Handles rate limiting, pagination
- Supports all needed operations (issues, PRs, comments)

**Alternatives Considered**:
- @octokit/graphql: More efficient for complex queries, but REST sufficient for our needs
- Native fetch: More control but much more work

### 2. Validation Library

**Choice**: Zod

**Rationale**:
- Consistent with other plugins in monorepo
- Type inference for TypeScript
- Runtime validation for API responses

### 3. Logging

**Choice**: Pino

**Rationale**:
- Consistent with claude-code plugin
- Structured JSON logging
- High performance

### 4. Polling Strategy

**Choice**: Configurable interval with exponential backoff

**Implementation**:
```typescript
interface PollingConfig {
  initialIntervalMs: number;  // Default: 5000
  maxIntervalMs: number;      // Default: 60000
  backoffMultiplier: number;  // Default: 1.5
  maxRetries: number;         // Default: 100
}
```

**Rationale**:
- Respects GitHub API rate limits (5000/hour authenticated)
- Adapts to workspace completion time (seconds to hours)
- Configurable for different use cases

## Implementation Patterns

### Session/Workspace Model

Following the claude-code plugin pattern:
- Workspace is analogous to Session
- Explicit lifecycle: create → poll → retrieve → dispose
- Immutable status updates

### Error Hierarchy

```
PluginError (base)
├── WorkspaceNotFoundError
├── WorkspaceInvalidStateError
├── GitHubAPIError
│   ├── RateLimitError
│   └── AuthenticationError
└── PollingTimeoutError
```

### Type Guards

```typescript
function isWorkspaceComplete(workspace: Workspace): boolean {
  return ['review_ready', 'merged'].includes(workspace.status);
}

function isWorkspaceFailed(workspace: Workspace): boolean {
  return ['failed', 'not_available'].includes(workspace.status);
}
```

## Key Sources/References

1. **GitHub REST API Documentation**: https://docs.github.com/en/rest
2. **GitHub Copilot Documentation**: https://docs.github.com/en/copilot
3. **Octokit Documentation**: https://octokit.github.io/rest.js
4. **Existing Plugin Reference**: packages/generacy-plugin-claude-code/

## Recommendations

### Short Term (This Implementation)

1. Implement stub plugin with full type definitions
2. Use GitHub PR API for status tracking when workspace manually triggered
3. Design for future API integration with adapter pattern

### Medium Term (When API Available)

1. Implement Copilot Workspace API client
2. Add real status polling
3. Enable programmatic workspace creation

### Long Term

1. Webhook support for push-based status
2. Multi-workspace orchestration
3. Integration with other Copilot features (code suggestions, etc.)
