# Implementation Plan: @generacy-ai/generacy-plugin-github-issues

**Feature**: GitHub Issues integration plugin for Generacy
**Branch**: `012-plugin-generacy-ai-generacy`
**Status**: Complete

## Summary

This plugin provides a TypeScript-based GitHub Issues integration for the Generacy platform. It enables programmatic management of GitHub issues, including CRUD operations, label management, comment handling, and PR linking. The plugin supports webhook event streaming and configurable workflow triggers for agent-driven automation.

## Technical Context

| Aspect | Decision |
|--------|----------|
| Language | TypeScript 5.6+ |
| Module System | ES Modules (NodeNext) |
| Runtime | Node.js 20+ |
| HTTP Client | Octokit (official GitHub SDK) |
| Validation | Zod schemas |
| Testing | Vitest |
| Build | TypeScript compiler (tsc) |

## Dependencies

### Runtime Dependencies
- `@octokit/rest` - GitHub REST API client
- `@octokit/webhooks` - Webhook event parsing and verification
- `@octokit/types` - TypeScript types for GitHub API
- `zod` - Runtime schema validation

### Dev Dependencies
- `typescript` - Type checking and compilation
- `vitest` - Testing framework
- `@types/node` - Node.js type definitions

### Peer Dependencies
- `@generacy-ai/core` (#2) - Core plugin interface (when available)

## Project Structure

```
packages/github-issues/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                 # Main exports
│   ├── plugin.ts                # Plugin class implementation
│   ├── client.ts                # GitHub API client wrapper
│   ├── types/
│   │   ├── index.ts             # Type exports
│   │   ├── config.ts            # Configuration types
│   │   ├── issues.ts            # Issue-related types
│   │   ├── events.ts            # Webhook event types
│   │   └── responses.ts         # API response types
│   ├── operations/
│   │   ├── issues.ts            # Issue CRUD operations
│   │   ├── labels.ts            # Label management
│   │   ├── comments.ts          # Comment operations
│   │   └── pull-requests.ts     # PR linking operations
│   ├── webhooks/
│   │   ├── handler.ts           # Webhook event handler
│   │   ├── parser.ts            # Event parsing utilities
│   │   └── triggers.ts          # Workflow trigger logic
│   └── utils/
│       ├── errors.ts            # Custom error classes
│       └── validation.ts        # Input validation helpers
├── tests/
│   ├── unit/
│   │   ├── operations/
│   │   │   ├── issues.test.ts
│   │   │   ├── labels.test.ts
│   │   │   └── comments.test.ts
│   │   └── webhooks/
│   │       └── handler.test.ts
│   └── integration/
│       └── client.test.ts
└── README.md
```

## Implementation Approach

### Phase 1: Core Setup
- Initialize package with TypeScript configuration
- Set up Octokit client with auth configuration
- Define core type definitions

### Phase 2: Issue Operations
- Implement CRUD operations (create, get, update, close)
- Add search and list functionality
- Include input validation with Zod

### Phase 3: Label & Comment Operations
- Label add/remove operations
- Comment CRUD operations
- Batch operations support

### Phase 4: Webhook Handling
- Webhook signature verification
- Event parsing and routing
- Workflow trigger evaluation

### Phase 5: PR Integration
- PR linking to issues
- Linked PR queries
- Cross-reference management

## Key Design Decisions

### 1. Octokit over Raw HTTP
Using the official Octokit SDK provides:
- Type-safe API calls
- Automatic rate limit handling
- Built-in pagination support
- Webhook signature verification

### 2. Standalone Package (Initially)
The plugin will be implemented as a standalone package that exports a class implementing a simple interface. When Generacy Core (#2) defines its plugin interface, this package can be updated to implement it while maintaining backward compatibility.

### 3. PAT Token First
Initial implementation supports Personal Access Tokens (PAT) for simplicity. The client interface is designed to allow GitHub App authentication to be added later without breaking changes.

### 4. Webhook Consumer Pattern
The plugin exposes a `handleWebhook` method that receives already-parsed webhook events. This allows flexibility in how webhooks are delivered (HTTP server, queue consumer, etc.) without coupling the plugin to specific infrastructure.

## API Overview

```typescript
// Main plugin interface
class GitHubIssuesPlugin {
  constructor(config: GitHubIssuesConfig);

  // Issues
  createIssue(params: CreateIssueParams): Promise<Issue>;
  getIssue(number: number): Promise<Issue>;
  updateIssue(number: number, params: UpdateIssueParams): Promise<Issue>;
  closeIssue(number: number): Promise<void>;
  searchIssues(query: string): Promise<Issue[]>;
  listIssues(filter?: IssueFilter): Promise<Issue[]>;

  // Labels
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  removeLabels(issueNumber: number, labels: string[]): Promise<void>;

  // Comments
  addComment(issueNumber: number, body: string): Promise<Comment>;
  listComments(issueNumber: number): Promise<Comment[]>;

  // Pull Requests
  linkPullRequest(issueNumber: number, prNumber: number): Promise<void>;
  getLinkedPRs(issueNumber: number): Promise<PullRequest[]>;

  // Webhooks
  handleWebhook(event: WebhookEvent): Promise<WorkflowAction | null>;
}
```

## Testing Strategy

### Unit Tests
- Mock Octokit client for operation tests
- Test validation logic independently
- Test webhook event parsing

### Integration Tests
- Use GitHub API against test repository
- Requires `GITHUB_TOKEN` environment variable
- Can be skipped in CI with `--skip-integration` flag

## Configuration

```typescript
interface GitHubIssuesConfig {
  // Required
  owner: string;          // Repository owner
  repo: string;           // Repository name
  token: string;          // GitHub PAT or App token

  // Optional
  webhookSecret?: string; // For signature verification
  agentAccount?: string;  // Username for assignment detection
  triggerLabels?: string[]; // Labels that trigger workflows
  baseUrl?: string;       // For GitHub Enterprise
}
```

## Error Handling

Custom error classes for different failure modes:
- `GitHubAuthError` - Authentication failures
- `GitHubRateLimitError` - Rate limit exceeded
- `GitHubNotFoundError` - Resource not found
- `GitHubValidationError` - Invalid input parameters
- `WebhookVerificationError` - Invalid webhook signature

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Rate limiting | Implement exponential backoff, cache responses |
| API changes | Pin Octokit version, comprehensive type coverage |
| Webhook reliability | Idempotent handlers, event deduplication |
| Token security | Never log tokens, support secret managers |

---

*Generated by speckit*
