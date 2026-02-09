# Implementation Plan: Wire Generacy Plugins to Extend Latency Base Classes

**Feature**: Refactor 6 Generacy plugins to extend Latency abstract base classes
**Branch**: `173-wire-generacy-plugins-extend`
**Status**: Complete

## Summary

This refactoring wires 6 Generacy plugin packages to extend their corresponding Latency abstract base classes, implementing the Component Extension pattern from the Latency architecture. Each Generacy plugin will become a thin wrapper that delegates to Latency's standardized lifecycle management, error handling, and interface contracts.

## Technical Context

| Aspect | Details |
|--------|---------|
| Language | TypeScript 5.6+ |
| Module System | ESM (`"type": "module"`) |
| Monorepo | pnpm workspace |
| Testing | Vitest |
| Build | tsc |

## Plugin Mapping

| Generacy Plugin | Latency Base Class | Latency Package |
|-----------------|-------------------|-----------------|
| `@generacy-ai/generacy-plugin-copilot` | `AbstractDevAgentPlugin` | `@generacy-ai/latency-plugin-dev-agent` |
| `@generacy-ai/generacy-plugin-claude-code` | `AbstractDevAgentPlugin` | `@generacy-ai/latency-plugin-dev-agent` |
| `@generacy-ai/generacy-plugin-cloud-build` | `AbstractCICDPlugin` | `@generacy-ai/latency-plugin-ci-cd` |
| `@generacy-ai/generacy-plugin-github-issues` | `AbstractIssueTrackerPlugin` | `@generacy-ai/latency-plugin-issue-tracker` |
| `@generacy-ai/generacy-plugin-jira` | `AbstractIssueTrackerPlugin` | `@generacy-ai/latency-plugin-issue-tracker` |
| `@generacy-ai/generacy-plugin-github-actions` | `AbstractCICDPlugin` | `@generacy-ai/latency-plugin-ci-cd` |

## Project Structure

```
packages/
├── generacy-plugin-copilot/
│   ├── package.json          # Add @generacy-ai/latency-plugin-dev-agent
│   └── src/
│       └── plugin/
│           └── copilot-plugin.ts  # Extend AbstractDevAgentPlugin
│
├── generacy-plugin-claude-code/
│   ├── package.json          # Add @generacy-ai/latency-plugin-dev-agent
│   └── src/
│       └── plugin/
│           └── claude-code-plugin.ts  # Extend AbstractDevAgentPlugin
│
├── generacy-plugin-cloud-build/
│   ├── package.json          # Add @generacy-ai/latency-plugin-ci-cd
│   └── src/
│       └── plugin.ts         # Extend AbstractCICDPlugin
│
├── github-issues/
│   ├── package.json          # Add @generacy-ai/latency-plugin-issue-tracker
│   └── src/
│       └── plugin.ts         # Extend AbstractIssueTrackerPlugin
│
├── jira/
│   ├── package.json          # Add @generacy-ai/latency-plugin-issue-tracker
│   └── src/
│       └── plugin.ts         # Extend AbstractIssueTrackerPlugin
│
└── github-actions/
    ├── package.json          # Add @generacy-ai/latency-plugin-ci-cd
    └── src/
        └── plugin.ts         # Extend AbstractCICDPlugin, remove local IssueTracker
```

## Implementation Approach

### Phase 1: Dev Agent Plugins

For `generacy-plugin-copilot` and `generacy-plugin-claude-code`:

1. Add dependency: `"@generacy-ai/latency-plugin-dev-agent": "workspace:*"`
2. Import `AbstractDevAgentPlugin` from `@generacy-ai/latency-plugin-dev-agent`
3. Change class declaration to `extends AbstractDevAgentPlugin`
4. Implement required abstract methods:
   - `doInvoke(prompt, options)` → Provider-specific invocation
   - `doInvokeStream(prompt, options)` → Provider-specific streaming
   - `doGetCapabilities()` → Return agent capabilities

**Benefits gained:**
- Automatic invocation tracking with unique IDs
- Built-in timeout management
- Cancellation token support
- Consistent error normalization to `FacetError`

### Phase 2: CI/CD Plugins

For `generacy-plugin-cloud-build` and `github-actions`:

1. Add dependency: `"@generacy-ai/latency-plugin-ci-cd": "workspace:*"`
2. Import `AbstractCICDPlugin` from `@generacy-ai/latency-plugin-ci-cd`
3. Change class declaration to `extends AbstractCICDPlugin`
4. Implement required abstract methods:
   - `doTrigger(pipelineId, options)` → Trigger build/workflow
   - `doGetStatus(runId)` → Get run status
   - `doCancel(runId)` → Cancel run
   - `doListPipelines()` → List available pipelines/workflows
5. For `github-actions`: Remove local `IssueTracker` interface redefinition

**Benefits gained:**
- Input validation on public methods
- Consistent `PipelineRun` and `PipelineStatus` types
- Error mapping to standard codes

### Phase 3: Issue Tracker Plugins

For `github-issues` and `jira`:

1. Add dependency: `"@generacy-ai/latency-plugin-issue-tracker": "workspace:*"`
2. Import `AbstractIssueTrackerPlugin` from `@generacy-ai/latency-plugin-issue-tracker`
3. Change class declaration to `extends AbstractIssueTrackerPlugin`
4. Implement required abstract methods:
   - `fetchIssue(id)` → Get single issue
   - `doCreateIssue(spec)` → Create new issue
   - `doUpdateIssue(id, update)` → Update existing issue
   - `doListIssues(query)` → Search/list issues
   - `doAddComment(issueId, comment)` → Add comment

**Benefits gained:**
- Built-in result caching with TTL
- Cache invalidation helpers
- Input validation
- Consistent `Issue`, `IssueSpec`, `IssueQuery` types

## Test Strategy

For each plugin:
1. Verify existing tests pass after refactoring
2. Ensure abstract method implementations are covered
3. Test that inherited base class behavior works (e.g., caching, cancellation)

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking API changes | Keep public API identical; only internal inheritance changes |
| Type mismatches | Latency types should be compatible; map if needed |
| Missing Latency packages | Verify all packages exist in workspace before starting |

## Success Criteria

- [ ] All 6 plugins extend their Latency base classes
- [ ] No local interface redefinitions (e.g., `IssueTracker` in github-actions)
- [ ] Dependencies added as `workspace:*`
- [ ] All existing tests pass
- [ ] `pnpm build` succeeds for all affected packages
