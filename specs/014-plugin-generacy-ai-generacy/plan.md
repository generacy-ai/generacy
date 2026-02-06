# Implementation Plan: @generacy-ai/generacy-plugin-copilot

**Feature**: GitHub Copilot agent platform plugin for Generacy
**Branch**: `014-plugin-generacy-ai-generacy`
**Status**: Complete

## Summary

Implement a Generacy plugin for GitHub Copilot Workspace integration. Due to the current lack of a public Copilot Workspace API (as noted in clarifications), this implementation will:

1. **Primary approach**: Implement a placeholder/stub plugin that follows the established plugin architecture patterns
2. **Extensibility**: Design for future API integration when available
3. **Fallback**: Support manual workspace triggering with GitHub Issues/PRs APIs for status tracking

## Technical Context

- **Language**: TypeScript (ES modules)
- **Framework**: Node.js (>=20.0.0)
- **Dependencies**: @octokit/rest, zod, pino (following existing plugin patterns)
- **Testing**: Vitest
- **Build**: TypeScript compiler (tsc)

### Reference Implementation

The plugin follows patterns established in `@generacy-ai/generacy-plugin-claude-code`:
- Session-based architecture with explicit lifecycle management
- Zod schemas for runtime validation
- Typed error hierarchy with error codes
- AsyncIterable output streaming
- Pino-based structured logging

## Project Structure

```
packages/generacy-plugin-copilot/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                    # Public API exports
│   ├── types.ts                    # Core type definitions
│   ├── schemas.ts                  # Zod validation schemas
│   ├── errors.ts                   # Error class hierarchy
│   ├── plugin/
│   │   └── copilot-plugin.ts       # Main plugin class
│   ├── workspace/
│   │   ├── workspace-manager.ts    # Workspace lifecycle management
│   │   └── types.ts                # Workspace-specific types
│   ├── polling/
│   │   ├── status-poller.ts        # Status polling implementation
│   │   └── types.ts                # Polling configuration types
│   └── github/
│       ├── client.ts               # GitHub API client wrapper
│       └── types.ts                # GitHub-specific types
└── tests/
    ├── plugin.test.ts
    ├── workspace.test.ts
    └── polling.test.ts
```

## Core Interfaces

### Plugin Interface

```typescript
interface CopilotPluginInterface {
  // Workspace lifecycle
  createWorkspace(params: CreateWorkspaceParams): Promise<Workspace>;
  getWorkspace(workspaceId: string): Promise<Workspace | null>;
  pollWorkspaceStatus(workspaceId: string): Promise<WorkspaceStatus>;

  // Output retrieval
  getChanges(workspaceId: string): Promise<FileChange[]>;
  getPullRequest(workspaceId: string): Promise<PullRequest | null>;

  // Status streaming
  streamStatus(workspaceId: string): AsyncIterable<WorkspaceStatusEvent>;

  // Cleanup
  dispose(): Promise<void>;
}
```

### Workspace Types

```typescript
interface Workspace {
  id: string;
  issueUrl: string;
  status: WorkspaceStatus;
  createdAt: Date;
  updatedAt: Date;
  pullRequestUrl?: string;
}

type WorkspaceStatus =
  | 'pending'
  | 'planning'
  | 'implementing'
  | 'review_ready'
  | 'merged'
  | 'failed'
  | 'not_available';  // When Copilot API unavailable

interface CreateWorkspaceParams {
  issueUrl: string;
  options?: {
    autoMerge?: boolean;
    reviewRequired?: boolean;
  };
}
```

## Implementation Strategy

### Phase 1: Stub Implementation (Current Scope)

Given API uncertainty, implement:
- Full type definitions following plugin patterns
- Stub methods returning `WorkspaceStatus.not_available`
- GitHub Issues API integration for tracking
- Polling infrastructure ready for future API

### Phase 2: API Integration (Future)

When Copilot Workspace API becomes available:
- Implement actual workspace creation
- Enable status polling
- Connect output retrieval

### Phase 3: Enhanced Integration (Future)

- Webhook support for real-time status
- Browser automation fallback (if needed)
- Retry/circuit breaker patterns

## Constitution Check

No constitution.md file exists at `.specify/memory/constitution.md`. Proceeding with standard implementation patterns.

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Session model | Workspace-based | Matches Copilot Workspace paradigm |
| API uncertainty | Stub with extensibility | Allows forward progress while API unclear |
| Polling strategy | Configurable interval | Flexibility for API rate limits |
| Error handling | Typed error hierarchy | Consistency with claude-code plugin |
| GitHub integration | Reuse @octokit/rest | Consistency with github-issues plugin |

## Dependencies

```json
{
  "dependencies": {
    "@octokit/rest": "^21.0.2",
    "pino": "^9.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  },
  "peerDependencies": {
    "@generacy-ai/generacy": "^0.1.0"
  }
}
```

## Integration Points

### Workflow Engine Integration

```typescript
// The plugin exposes a standardized interface for workflow integration
const copilot = new CopilotPlugin({ githubToken });

// Triggered by workflow engine
const workspace = await copilot.createWorkspace({
  issueUrl: 'https://github.com/owner/repo/issues/123'
});

// Status can be polled or streamed
for await (const event of copilot.streamStatus(workspace.id)) {
  console.log(`Status: ${event.status}`);
}
```

### Orchestrator Integration

The plugin integrates with the generacy orchestrator as a job handler:
- Can be assigned issues as jobs
- Reports progress via heartbeats
- Returns structured job results

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| No public API | Stub implementation with clear extensibility path |
| API changes | Version-pinned schemas, adapter pattern |
| Rate limiting | Configurable polling with backoff |
| Workspace failures | Retry logic with timeout handling |

## Out of Scope

- Browser automation (deferred pending clarification)
- Real-time webhooks (requires server infrastructure)
- Multi-organization support (v2 feature)
