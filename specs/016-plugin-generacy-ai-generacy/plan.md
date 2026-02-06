# Implementation Plan: GitHub Actions Plugin

**Feature**: GitHub Actions integration plugin for CI/CD workflow orchestration
**Branch**: `016-plugin-generacy-ai-generacy`
**Status**: Complete

## Summary

Implement `@generacy-ai/generacy-plugin-github-actions`, a plugin that provides programmatic access to GitHub Actions workflows. The plugin follows the Latency architecture pattern (extends base plugin, uses facets for cross-plugin communication) and enables:

1. **Workflow Triggering**: Trigger CI/CD workflows with custom inputs
2. **Status Monitoring**: Poll for workflow run status changes
3. **Log Retrieval**: Fetch job logs after completion
4. **Artifact Management**: Download workflow artifacts
5. **Check Run Integration**: Create and update GitHub Check Runs
6. **Event Emission**: Publish workflow events via EventBus facet

## Technical Context

- **Language**: TypeScript (ES Modules)
- **Node Version**: >=20.0.0
- **Framework**: Standalone plugin (no web framework)
- **Package Manager**: pnpm
- **Testing**: Vitest
- **Dependencies**:
  - `@octokit/rest` - GitHub API client
  - `@octokit/types` - GitHub API types
  - `zod` - Runtime validation
  - (peer) EventBus facet for event emission
  - (optional peer) IssueTracker facet for status linking

## Project Structure

```
packages/github-actions/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                    # Public exports
│   ├── plugin.ts                   # GitHubActionsPlugin class
│   ├── client.ts                   # GitHub API client wrapper
│   ├── types/
│   │   ├── index.ts                # Type barrel export
│   │   ├── config.ts               # Configuration types & schema
│   │   ├── workflows.ts            # Workflow run types
│   │   ├── jobs.ts                 # Job & step types
│   │   ├── artifacts.ts            # Artifact types
│   │   ├── check-runs.ts           # Check run types
│   │   └── events.ts               # Event emission types
│   ├── operations/
│   │   ├── workflows.ts            # Workflow triggering
│   │   ├── runs.ts                 # Run monitoring & control
│   │   ├── jobs.ts                 # Job & log operations
│   │   ├── artifacts.ts            # Artifact download
│   │   └── check-runs.ts           # Check run CRUD
│   ├── polling/
│   │   ├── status-poller.ts        # Polling loop implementation
│   │   └── types.ts                # Polling configuration
│   ├── events/
│   │   ├── emitter.ts              # EventBus integration
│   │   └── types.ts                # Event payload types
│   └── utils/
│       ├── errors.ts               # Custom error classes
│       └── validation.ts           # Input validation
└── __tests__/
    ├── plugin.test.ts
    ├── operations/
    │   ├── workflows.test.ts
    │   ├── runs.test.ts
    │   └── check-runs.test.ts
    └── polling/
        └── status-poller.test.ts
```

## Key Technical Decisions

### 1. Polling Architecture

The plugin uses polling rather than webhooks for status monitoring:
- Configurable interval (default: 10s)
- Max attempts limit (default: 60)
- Exponential backoff on rate limiting
- Auto-stop on terminal states (success/failure/cancelled)

```typescript
interface PollingConfig {
  interval: number;      // ms between polls
  maxAttempts: number;   // max poll count
  onUpdate: (run: WorkflowRun) => void;
  onComplete: (run: WorkflowRun) => void;
  onError: (error: Error) => void;
}
```

### 2. Event Emission via Facets

Events are emitted through an injected EventBus facet:
```typescript
// Events emitted
eventBus.emit('workflow.completed', { runId, conclusion, workflow });
eventBus.emit('workflow.failed', { runId, error, workflow });
eventBus.emit('check_run.completed', { checkRunId, conclusion });
```

### 3. Optional IssueTracker Integration

When an IssueTracker facet is available, the plugin can:
- Comment on issues when workflows complete
- Link workflow runs to issue metadata

### 4. Token-Only Authentication

Simple PAT-based auth matching the existing `github-issues` plugin pattern:
```typescript
interface GitHubActionsConfig {
  owner: string;
  repo: string;
  token: string;  // Personal Access Token
}
```

## Dependencies

### Required Facets
- **EventBus**: For emitting workflow events

### Optional Facets
- **IssueTracker**: For status linking to issues

### NPM Dependencies
| Package | Version | Purpose |
|---------|---------|---------|
| @octokit/rest | ^21.0.2 | GitHub API client |
| @octokit/types | ^13.6.2 | TypeScript types |
| zod | ^3.23.8 | Schema validation |

### Dev Dependencies
| Package | Version | Purpose |
|---------|---------|---------|
| typescript | ^5.7.2 | TypeScript compiler |
| vitest | ^2.1.8 | Test runner |
| @types/node | ^22.10.2 | Node.js types |

## Constitution Check

N/A - No `.specify/memory/constitution.md` file exists in this repository.

## Integration Points

| Consumer | Integration Method |
|----------|-------------------|
| Orchestrator | Import plugin, inject facets |
| Other plugins | Via EventBus events |
| Issue tracker | Via IssueTracker facet |

## Risk Considerations

1. **Rate Limiting**: GitHub API has rate limits; polling must respect these
2. **Long-Running Workflows**: Max poll attempts may be insufficient for slow workflows
3. **Network Reliability**: Polling requires stable network; implement retries

## Next Steps

After plan approval:
1. Generate task list with `/speckit:tasks`
2. Implement core types and config
3. Build operations layer
4. Add polling infrastructure
5. Integrate event emission
6. Write comprehensive tests
