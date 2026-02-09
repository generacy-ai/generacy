# Research: Latency Plugin Extension Pattern

## Overview

The Latency architecture defines abstract base classes for plugin categories that provide standardized lifecycle management, error handling, and interface contracts. Generacy component plugins should extend these base classes rather than implementing standalone classes.

## Base Class Categories

### 1. AbstractDevAgentPlugin

**Package**: `@generacy-ai/latency-plugin-dev-agent`

**Purpose**: Base class for AI development agent plugins (Claude Code, Copilot, etc.)

**Interface Implemented**: `DevAgent`

**Abstract Methods to Implement**:
```typescript
protected abstract doInvoke(
  prompt: string,
  options: InternalInvokeOptions,
): Promise<AgentResult>;

protected abstract doInvokeStream(
  prompt: string,
  options: InternalInvokeOptions,
): AsyncIterableIterator<StreamChunk>;

protected abstract doGetCapabilities(): Promise<AgentCapabilities>;
```

**Provided Behavior**:
- Invocation tracking with unique IDs
- Timeout management (default 30s, configurable)
- Cancellation token support
- Error normalization to `FacetError`

### 2. AbstractCICDPlugin

**Package**: `@generacy-ai/latency-plugin-ci-cd`

**Purpose**: Base class for CI/CD pipeline plugins (Cloud Build, GitHub Actions, etc.)

**Interface Implemented**: `CICDPipeline`

**Abstract Methods to Implement**:
```typescript
protected abstract doTrigger(
  pipelineId: string,
  options?: TriggerOptions,
): Promise<PipelineRun>;

protected abstract doGetStatus(runId: string): Promise<PipelineRun>;

protected abstract doCancel(runId: string): Promise<void>;

protected abstract doListPipelines(): Promise<Pipeline[]>;
```

**Provided Behavior**:
- Input validation on all public methods
- Consistent error codes
- Standard pipeline status mapping

### 3. AbstractIssueTrackerPlugin

**Package**: `@generacy-ai/latency-plugin-issue-tracker`

**Purpose**: Base class for issue tracker plugins (GitHub Issues, Jira, etc.)

**Interface Implemented**: `IssueTracker`

**Abstract Methods to Implement**:
```typescript
protected abstract fetchIssue(id: string): Promise<Issue>;

protected abstract doCreateIssue(spec: IssueSpec): Promise<Issue>;

protected abstract doUpdateIssue(id: string, update: IssueUpdate): Promise<Issue>;

protected abstract doListIssues(query: IssueQuery): Promise<PaginatedResult<Issue>>;

protected abstract doAddComment(issueId: string, comment: string): Promise<Comment>;
```

**Provided Behavior**:
- Result caching with configurable TTL (default 60s)
- Cache invalidation helpers
- Input validation
- Extensible validation methods

## Design Pattern: Template Method

All Latency base classes use the Template Method pattern:

1. **Public methods** (e.g., `getIssue`, `triggerPipeline`, `invoke`) are final and:
   - Validate inputs
   - Apply common logic (caching, timeouts, tracking)
   - Delegate to abstract `do*` methods
   - Normalize errors

2. **Protected abstract methods** (e.g., `fetchIssue`, `doTrigger`, `doInvoke`) are:
   - Implemented by subclasses
   - Focus on provider-specific logic only
   - Trust that inputs are pre-validated

## Benefits of Extending Base Classes

| Benefit | Description |
|---------|-------------|
| Consistency | All plugins expose identical public APIs |
| Reduced boilerplate | Common logic handled by base class |
| Error handling | Automatic mapping to `FacetError` with standard codes |
| Caching | Built-in for issue trackers with TTL |
| Cancellation | Token-based cancellation for dev agents |
| Validation | Input validation on public methods |
| Testing | Base class behavior tested once, reused everywhere |

## Implementation References

Existing Latency plugin implementations to use as references:

1. **ClaudeCodePlugin** (`latency-plugin-claude-code`)
   - Extends `AbstractDevAgentPlugin`
   - Uses subprocess invocation via execa
   - Good example of stream implementation

2. **GitHubActionsPlugin** (`latency-plugin-github-actions`)
   - Extends `AbstractCICDPlugin`
   - Uses Octokit REST client
   - Maps workflow status to `PipelineStatus`

3. **GitHubIssuesPlugin** (`latency-plugin-github-issues`)
   - Extends `AbstractIssueTrackerPlugin`
   - Uses GitHubClient
   - Good example of caching usage

4. **JiraPlugin** (`latency-plugin-jira`)
   - Extends `AbstractIssueTrackerPlugin`
   - Uses injectable HTTP adapter
   - Overrides validation methods

## Alternatives Considered

### Option A: Standalone Classes (Current State)
- **Pros**: No external dependencies, full control
- **Cons**: Duplicated logic, inconsistent APIs, no shared behavior

### Option B: Composition Instead of Inheritance
- **Pros**: More flexible, avoids inheritance hierarchy
- **Cons**: More boilerplate, doesn't leverage Template Method benefits

### Option C: Extend Latency Base Classes (Selected)
- **Pros**: Consistent APIs, reduced boilerplate, shared behavior
- **Cons**: Tight coupling to Latency (acceptable - same org)

## Key Sources

- `/workspaces/latency/packages/latency-plugin-dev-agent/src/abstract-dev-agent-plugin.ts`
- `/workspaces/latency/packages/plugin-ci-cd/src/abstract-ci-cd-plugin.ts`
- `/workspaces/latency/packages/latency-plugin-issue-tracker/src/abstract-plugin.ts`
- Latency architecture documentation (referenced in issue)
